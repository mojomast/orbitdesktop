import { env, pipeline } from "@huggingface/transformers";
const modelDir = process.argv[2];
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useFSCache = false;
env.localModelPath = modelDir;
let extractor;
let queue = Promise.resolve();
async function perform({ id, texts }) {
  try {
    extractor ??= await pipeline("feature-extraction", modelDir, {
      dtype: "q8",
      device: "cpu",
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    });
    const result = await extractor(texts, {
      pooling: "mean",
      normalize: true,
      truncation: true,
      max_length: 256,
    });
    process.send?.({ id, vectors: result.tolist() });
  } catch {
    process.send?.({ id, error: "Local model inference unavailable" });
  }
}
process.on("message", (message) => {
  queue = queue.then(() => perform(message));
});
process.on("disconnect", () => process.exit());
