export interface SecurityHeadersOptions {
  readonly production: boolean;
  /** 例如 WSS/API 的额外来源；每项必须是已审核的 CSP source。 */
  readonly connectSources?: readonly string[];
  readonly reportUri?: string;
}

const CSP_SOURCE_PATTERN =
  /^(?:'self'|'none'|https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?|wss?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?)$/u;

/**
 * 返回可直接写入响应的安全头。默认 CSP 不允许内联脚本、eval、嵌入页面、
 * 插件对象或任意第三方资源。
 */
export function buildSecurityHeaders(
  options: SecurityHeadersOptions,
): Readonly<Record<string, string>> {
  const connectSources = ["'self'", ...(options.connectSources ?? [])];
  for (const source of connectSources) {
    if (!CSP_SOURCE_PATTERN.test(source)) {
      throw new TypeError(`不安全或不合法的 CSP connect-src: ${source}`);
    }
  }
  if (
    options.reportUri !== undefined &&
    (!options.reportUri.startsWith("/") ||
      options.reportUri.startsWith("//") ||
      /[\s;]/u.test(options.reportUri))
  ) {
    throw new TypeError("CSP report-uri 必须是站内绝对路径");
  }

  const directives = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${[...new Set(connectSources)].join(" ")}`,
    "upgrade-insecure-requests",
  ];
  if (options.reportUri) directives.push(`report-uri ${options.reportUri}`);

  const headers: Record<string, string> = {
    "Content-Security-Policy": directives.join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  if (options.production) {
    headers["Strict-Transport-Security"] =
      "max-age=31536000; includeSubDomains";
  }
  return Object.freeze(headers);
}
