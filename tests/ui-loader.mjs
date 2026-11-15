export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved.url.endsWith("/src/client.ts") &&
    context.parentURL?.includes("/src/main")
  )
    return {
      url: new URL("./ui-fixture.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  return resolved;
}
