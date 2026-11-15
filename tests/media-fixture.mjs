export { normalizeAssets } from "../backend/media.ts";
export const downloads = [];
export async function downloadMedia(url, thumbnail) {
  downloads.push({ url, thumbnail });
  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode("synthetic original media"),
        );
        controller.close();
      },
    }),
    contentType: "image/png",
  };
}
