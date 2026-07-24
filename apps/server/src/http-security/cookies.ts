export type CookieRuntime = "development" | "production";

export interface SecurityCookieNames {
  readonly session: string;
  readonly device: string;
}

export interface SecurityCookiePolicy {
  readonly names: SecurityCookieNames;
  readonly attributes: {
    readonly secure: boolean;
    readonly httpOnly: true;
    readonly sameSite: "Lax";
    readonly path: "/";
  };
}

const COOKIE_VALUE_PATTERN = /^[\x21-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/u;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

/**
 * 开发环境必须使用显式不同名，避免浏览器中残留的生产 Secure Cookie
 * 与本地非 HTTPS Cookie 互相遮蔽。
 */
export function createSecurityCookiePolicy(
  runtime: CookieRuntime,
): SecurityCookiePolicy {
  const production = runtime === "production";
  return {
    names: production
      ? {
          session: "__Host-session",
          device: "__Host-device",
        }
      : {
          session: "dev-session",
          device: "dev-device",
        },
    attributes: {
      secure: production,
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    },
  };
}

/**
 * 解析 Cookie 请求头。若同名 Cookie 出现多次则拒绝，避免代理、框架和业务层
 * 对“取第一个还是最后一个”产生不同解释。
 */
export function parseCookieHeader(
  header: string | undefined,
): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 1) continue;

    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (!COOKIE_NAME_PATTERN.test(name) || !COOKIE_VALUE_PATTERN.test(value)) {
      throw new TypeError("Cookie 请求头包含非法字符");
    }
    if (cookies.has(name)) {
      throw new TypeError(`Cookie 请求头包含重复名称: ${name}`);
    }
    cookies.set(name, value);
  }

  return cookies;
}

export function serializeSecurityCookie(
  name: string,
  value: string,
  policy: SecurityCookiePolicy,
  options: {
    readonly maxAgeSeconds?: number;
    readonly expires?: Date;
  } = {},
): string {
  if (!COOKIE_NAME_PATTERN.test(name)) {
    throw new TypeError("Cookie 名称不合法");
  }
  if (!COOKIE_VALUE_PATTERN.test(value)) {
    throw new TypeError("Cookie 值不合法");
  }
  if (
    options.maxAgeSeconds !== undefined &&
    (!Number.isSafeInteger(options.maxAgeSeconds) ||
      options.maxAgeSeconds < 0)
  ) {
    throw new TypeError("Cookie Max-Age 必须是非负安全整数");
  }
  if (options.expires && Number.isNaN(options.expires.getTime())) {
    throw new TypeError("Cookie Expires 日期不合法");
  }

  const parts = [
    `${name}=${value}`,
    `Path=${policy.attributes.path}`,
    `SameSite=${policy.attributes.sameSite}`,
    "HttpOnly",
  ];
  if (policy.attributes.secure) parts.push("Secure");
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  return parts.join("; ");
}

export function serializeSessionCookie(
  value: string,
  policy: SecurityCookiePolicy,
  options?: {
    readonly maxAgeSeconds?: number;
    readonly expires?: Date;
  },
): string {
  return serializeSecurityCookie(policy.names.session, value, policy, options);
}

export function serializeDeviceCookie(
  value: string,
  policy: SecurityCookiePolicy,
  options?: {
    readonly maxAgeSeconds?: number;
    readonly expires?: Date;
  },
): string {
  return serializeSecurityCookie(policy.names.device, value, policy, options);
}
