function escapeLabel(value: string): string {
  return value
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/[\\[\]*_`<>|~&]/g, "\\$&");
}

function escapeDestination(value: string): string {
  return value.replaceAll("(", "%28").replaceAll(")", "%29");
}

export function validateAttachmentUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("finalize response contains an invalid attachment URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname !== "github.com" ||
    (!url.pathname.startsWith("/user-attachments/assets/") &&
      !url.pathname.startsWith("/user-attachments/files/"))
  ) {
    throw new Error("finalize response contains an untrusted attachment URL");
  }
  return url.toString();
}

export function renderMarkdown(name: string, href: string, contentType: string): string {
  const safeHref = validateAttachmentUrl(href);
  if (contentType.startsWith("video/")) return safeHref;
  const safeName = escapeLabel(name);
  const destination = escapeDestination(safeHref);
  return contentType.startsWith("image/")
    ? `![${safeName}](${destination})`
    : `[${safeName}](${destination})`;
}
