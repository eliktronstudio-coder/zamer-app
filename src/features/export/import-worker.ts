import { decodeProject } from "./package";
self.onmessage = async (
  event: MessageEvent<{ bytes: Uint8Array; isJson: boolean }>,
) => {
  try {
    const result = await decodeProject(event.data.bytes, event.data.isJson);
    self.postMessage(
      { result },
      {
        transfer: [
          ...new Set(
            [...result.files.values()].map(
              (bytes) => bytes.buffer as ArrayBuffer,
            ),
          ),
        ],
      },
    );
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error ? error.message : "Не удалось прочитать архив",
    });
  }
};
