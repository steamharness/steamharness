import { defaultUrlTransform, type UrlTransform } from "react-markdown";

const imageData = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i;
const spaceAttachment = /^database:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Hosts resolve space attachments through their authenticated data API. */
export const transformKnowledgeMarkdownUrl: UrlTransform = (url, key, node) => {
  if (key === "src" && node.tagName === "img") {
    if (imageData.test(url.trim())) return url.replace(/\s+/g, "");
    if (spaceAttachment.test(url)) return url;
  }
  return defaultUrlTransform(url);
};
