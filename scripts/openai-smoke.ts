import { OpenAIProvider, readConfigFromEnv } from "../src/openai";
import type { ChatMessage } from "../src/openai";

function modelFromArgv(argv: string[]): string {
  const index = argv.indexOf("--model");
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value === "") {
    return "deepseek-v4.1-flash";
  }
  return value;
}

const model = modelFromArgv(Bun.argv);
const config = readConfigFromEnv(model);
const provider = new OpenAIProvider(config);
const messages: ChatMessage[] = [
  { role: "system", content: "Reply with the single word: pong" },
  { role: "user", content: "ping" },
];

const response = await provider.chat(messages, undefined, { temperature: 0 });
const content = response.content?.trim() ?? "";
if (content === "") {
  throw new Error("expected a non-empty completion");
}
console.log(content);
