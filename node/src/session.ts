import { GitHubHttp, responseTextLimited, type GitHubHttpOptions } from "./http.js";

const userLoginPattern = /<meta name="user-login" content="([^"]+)"/;

export interface SessionCheck {
  valid: boolean;
  username: string;
}

export async function checkSession(
  token: string,
  options: GitHubHttpOptions = {},
): Promise<SessionCheck> {
  const http = new GitHubHttp(token, options);
  const response = await http.request("/settings/profile", {
    headers: { "User-Agent": userAgent },
  });
  if (response.status === 302 || response.status === 303) {
    await response.body?.cancel();
    return { valid: false, username: "" };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`unexpected status while validating token: ${response.status}`);
  }
  const body = await responseTextLimited(response, 256 * 1024);
  return { valid: true, username: userLoginPattern.exec(body)?.[1] ?? "" };
}

export const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
