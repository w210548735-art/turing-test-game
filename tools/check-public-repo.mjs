import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const emailPattern = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi;
const ipPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const encodedSslipPattern =
  /\b(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.sslip\.io\b/gi;
const forbiddenPathPattern =
  /(^|\/)(?:infra\/secrets\/|references\/|\.private-backups\/)|\.(?:bundle|dump|tar\.gz)$/i;
const privateEnvPattern = /(^|\/)\.env(?:\.|$)/i;

const allowedEmailDomains = new Set([
  "example.com",
  "turing-game.local",
  "users.noreply.github.com",
]);
const allowedEmailLiterals = new Set(["fixture-never-send@qq.com"]);
const violations = [];

function isAllowedIp(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return false;
  if (ip === "0.0.0.0" || parts[0] === 127 || parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true;
  if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true;
  if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true;
  if (parts[0] === 28 && parts[1] === 0 && parts[2] === 0) return true;
  return false;
}

for (const file of files) {
  const isExampleEnv = file === ".env.example" || file.endsWith("/.env.example");
  if (
    forbiddenPathPattern.test(file) ||
    (privateEnvPattern.test(file) && !isExampleEnv)
  ) {
    violations.push(`${file}: 禁止跟踪的路径`);
    continue;
  }

  let content;
  try {
    content = execFileSync("git", ["show", `:${file}`], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    continue;
  }

  for (const match of content.matchAll(emailPattern)) {
    if (allowedEmailLiterals.has(match[0].toLowerCase())) continue;
    const domain = match[1].toLowerCase();
    if (!allowedEmailDomains.has(domain)) {
      violations.push(`${file}: 非示例邮箱`);
    }
  }

  for (const ip of content.match(ipPattern) ?? []) {
    if (!isAllowedIp(ip)) {
      violations.push(`${file}: 非示例公网 IP`);
    }
  }

  for (const match of content.matchAll(encodedSslipPattern)) {
    const ip = `${match[1]}.${match[2]}.${match[3]}.${match[4]}`;
    if (!isAllowedIp(ip)) {
      violations.push(`${file}: sslip.io 中包含非示例公网 IP`);
    }
  }
}

if (violations.length > 0) {
  console.error([...new Set(violations)].join("\n"));
  process.exit(1);
}

console.log(`公开仓库隐私检查通过，共检查 ${files.length} 个跟踪文件。`);
