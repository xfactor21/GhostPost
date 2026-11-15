import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { downloadMedia, type MediaDependencies } from "../backend/media";
function transport(
  responses: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
  }[],
  addresses = [{ address: "8.8.8.8", family: 4 }],
) {
  const observed: { url: string; headers: unknown; pinned?: unknown }[] = [];
  const deps = {
    resolve: async () => addresses,
    request: (url: URL, options: any, onResponse: any) => {
      const request = new EventEmitter() as any;
      request.destroy = () => {};
      request.end = () => {
        const definition = responses.shift();
        if (!definition) throw new Error("Unexpected network request");
        observed.push({ url: url.href, headers: options.headers });
        options.lookup(
          url.hostname,
          { all: false },
          (_error: any, address: any) => {
            observed[observed.length - 1].pinned = address;
          },
        );
        queueMicrotask(() => {
          const response = Readable.from([
            Buffer.from(definition.body || "image bytes"),
          ]) as any;
          response.headers = definition.headers || {
            "content-type": "image/png",
          };
          response.statusCode = definition.status || 200;
          onResponse(response);
        });
      };
      return request;
    },
  } as unknown as MediaDependencies;
  return { deps, observed };
}
test("safe media downloads pin DNS and forward no app credentials", async () => {
  const { deps, observed } = transport([{}]);
  const file = await downloadMedia(
    "https://cdn.example.org/image.png",
    false,
    0,
    Date.now() + 1000,
    deps,
  );
  assert.equal(file.contentType, "image/png");
  assert.equal(await new Response(file.body).text(), "image bytes");
  assert.equal(observed[0].pinned, "8.8.8.8");
  assert.deepEqual(Object.keys(observed[0].headers as object), ["Accept"]);
});
test("media redirects are revalidated and private destinations never get fetched", async () => {
  const { deps, observed } = transport([
    { status: 302, headers: { location: "https://127.0.0.1/secret" } },
  ]);
  await assert.rejects(
    downloadMedia(
      "https://cdn.example.org/image.png",
      false,
      0,
      Date.now() + 1000,
      deps,
    ),
    { code: "MEDIA_HOST_REJECTED" },
  );
  assert.equal(observed.length, 1);
});
test("mixed public/private DNS is rejected before an HTTP connection", async () => {
  const { deps, observed } = transport(
    [],
    [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
  );
  await assert.rejects(
    downloadMedia(
      "https://cdn.example.org/image.png",
      false,
      0,
      Date.now() + 1000,
      deps,
    ),
    { code: "MEDIA_HOST_REJECTED" },
  );
  assert.equal(observed.length, 0);
});
test("YouTube/HTML pages, expired files, unsupported previews and oversized files give useful errors", async () => {
  for (const [definition, thumbnail, code] of [
    [
      { headers: { "content-type": "text/html" } },
      false,
      "MEDIA_FORMAT_UNAVAILABLE",
    ],
    [{ status: 403 }, false, "BUFFER_MEDIA_UNAVAILABLE"],
    [
      { headers: { "content-type": "video/mp4" } },
      true,
      "MEDIA_FORMAT_UNAVAILABLE",
    ],
    [
      {
        headers: { "content-type": "video/mp4", "content-length": "60000000" },
      },
      false,
      "MEDIA_TOO_LARGE",
    ],
  ] as const) {
    const { deps } = transport([definition]);
    await assert.rejects(
      downloadMedia(
        "https://cdn.example.org/file",
        thumbnail,
        0,
        Date.now() + 1000,
        deps,
      ),
      { code },
    );
  }
});
test("media timeouts and redirect loops are bounded", async () => {
  const { deps } = transport([]);
  await assert.rejects(
    downloadMedia(
      "https://cdn.example.org/file",
      false,
      4,
      Date.now() + 1000,
      deps,
    ),
    { code: "BUFFER_MEDIA_UNAVAILABLE" },
  );
  await assert.rejects(
    downloadMedia(
      "https://cdn.example.org/file",
      false,
      0,
      Date.now() - 1,
      deps,
    ),
    { code: "MEDIA_DOWNLOAD_FAILED" },
  );
});
test("slow DNS cannot outlive the download deadline", async () => {
  const { deps } = transport([]);
  deps.resolve = (() => new Promise(() => {})) as MediaDependencies["resolve"];
  await assert.rejects(
    downloadMedia(
      "https://cdn.example.org/file",
      false,
      0,
      Date.now() + 10,
      deps,
    ),
    { code: "MEDIA_DOWNLOAD_FAILED" },
  );
});
test("unknown-length media streams enforce the byte limit while reading", async () => {
  const { deps } = transport([
    {
      headers: { "content-type": "image/png" },
      body: "x".repeat(2 * 1024 * 1024 + 1),
    },
  ]);
  const original = console.error;
  const logs: string[] = [];
  console.error = (line) => logs.push(String(line));
  try {
    const file = await downloadMedia(
      "https://cdn.example.org/file",
      true,
      0,
      Date.now() + 1000,
      deps,
    );
    await assert.rejects(new Response(file.body).arrayBuffer(), {
      code: "MEDIA_TOO_LARGE",
    });
    assert.equal(JSON.parse(logs[0]).code, "MEDIA_TOO_LARGE");
    assert.equal(logs[0].includes("cdn.example"), false);
  } finally {
    console.error = original;
  }
});
