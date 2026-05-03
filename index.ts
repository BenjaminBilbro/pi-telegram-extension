import { join, basename } from "node:path";
import { homedir } from "node:os";
import { readFile, stat } from "node:fs/promises";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface TelegramConfig {
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

interface TelegramSentMessage {
	message_id: number;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS_PER_TURN = 10;

const SYSTEM_PROMPT_SUFFIX = `

Telegram proactive messaging extension is active.
- You can send messages to the user on Telegram using the telegram_send tool.
- Use telegram_send when the user is messaging you from Telegram and you want to initiate a new conversation or follow up without waiting for them to message again.
- Use telegram_send when the user explicitly asks you to message them on Telegram.
- Messages longer than 4096 characters will be split into multiple messages automatically.`;

function isTelegramConfigAvailable(config: TelegramConfig): boolean {
	return !!config.botToken && !!config.allowedUserId;
}

function chunkParagraphs(text: string): string[] {
	if (text.length <= MAX_MESSAGE_LENGTH) return [text];

	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	const flushCurrent = (): void => {
		if (current.trim().length > 0) chunks.push(current);
		current = "";
	};

	const splitLongBlock = (block: string): string[] => {
		if (block.length <= MAX_MESSAGE_LENGTH) return [block];
		const lines = block.split("\n");
		const lineChunks: string[] = [];
		let lineCurrent = "";
		for (const line of lines) {
			const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = candidate;
				continue;
			}
			if (lineCurrent.length > 0) {
				lineChunks.push(lineCurrent);
				lineCurrent = "";
			}
			if (line.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = line;
				continue;
			}
			for (let i = 0; i < line.length; i += MAX_MESSAGE_LENGTH) {
				lineChunks.push(line.slice(i, i + MAX_MESSAGE_LENGTH));
			}
		}
		if (lineCurrent.length > 0) lineChunks.push(lineCurrent);
		return lineChunks;
	};

	for (const paragraph of paragraphs) {
		if (paragraph.length === 0) continue;
		const parts = splitLongBlock(paragraph);
		for (const part of parts) {
			const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				current = candidate;
			} else {
				flushCurrent();
				current = part;
			}
		}
	}
	flushCurrent();
	return chunks;
}

async function readConfig(): Promise<TelegramConfig> {
	try {
		const content = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(content) as TelegramConfig;
		return parsed;
	} catch {
		return {};
	}
}

export default function (pi: ExtensionAPI) {
	let config: TelegramConfig = {};
	let configChecked = false;

	async function callTelegram<TResponse>(
		method: string,
		body: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: options?.signal,
		});
		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function ensureConfig(): Promise<void> {
		if (configChecked) return;
		config = await readConfig();
		configChecked = true;
	}

	async function sendTelegramMessage(chatId: number | undefined, text: string): Promise<string> {
		await ensureConfig();

		if (!config.botToken) {
			throw new Error("Telegram bot token is not configured. Please set up the Telegram bridge first.");
		}

		if (!chatId) {
			// If no specific chat ID, try to use the allowedUserId's chat
			// We need to resolve this from the user's Telegram user ID to a chat ID
			// For now, we'll send to the bot's stored user
			if (config.allowedUserId) {
				// Telegram chat ID for private messages is the same as the user ID (negative for some cases)
				chatId = config.allowedUserId;
			} else {
				throw new Error("No Telegram chat ID available. The user must first message the bot to establish a connection.");
			}
		}

		const chunks = chunkParagraphs(text);
		const sentMessages: number[] = [];

		for (const chunk of chunks) {
			const result = await callTelegram<TelegramSentMessage>("sendMessage", {
				chat_id: chatId,
				text: chunk,
			});
			sentMessages.push(result.message_id);
		}

		return `Sent ${sentMessages.length} message(s) to Telegram (IDs: ${sentMessages.join(", ")}).`;
	}

	// Main tool that the LLM can call to proactively send messages
	pi.registerTool({
		name: "telegram_send",
		label: "Telegram Send",
		description: "Send a proactive message to the user on Telegram. Use this when you want to message the user directly on Telegram without them messaging you first.",
		promptSnippet: "Send a message to the user on Telegram",
		promptGuidelines: [
			"Use telegram_send when the user asks you to message them on Telegram.",
			"Use telegram_send when responding to a Telegram conversation and you want to send an unsolicited follow-up.",
			"Do not use telegram_send for regular terminal conversations - only when the user is actively communicating via Telegram.",
		],
		parameters: Type.Object({
			message: Type.String({ description: "The message text to send to the user on Telegram" }),
		}),
		async execute(_toolCallId, params) {
			await ensureConfig();

			try {
				const result = await sendTelegramMessage(config.allowedUserId, params.message);
				return {
					content: [{ type: "text", text: result }],
					details: { sent: true },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Failed to send Telegram message: ${message}` }],
					details: { error: message },
				};
			}
		},
	});

	// Allow sending with specific chat ID for advanced use
	pi.registerTool({
		name: "telegram_send_to",
		label: "Telegram Send To",
		description: "Send a message to a specific Telegram chat ID. Use telegram_send for the default user instead.",
		promptSnippet: "Send a message to a specific Telegram chat ID",
		promptGuidelines: [
			"Use telegram_send_to only when you know the specific chat ID to send to.",
			"Prefer telegram_send for general use as it sends to the paired user.",
		],
		parameters: Type.Object({
			chat_id: Type.Number({ description: "The Telegram chat ID to send to" }),
			message: Type.String({ description: "The message text to send" }),
		}),
		async execute(_toolCallId, params) {
			await ensureConfig();

			try {
				const result = await sendTelegramMessage(params.chat_id, params.message);
				return {
					content: [{ type: "text", text: result }],
					details: { sent: true, chat_id: params.chat_id },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Failed to send Telegram message: ${message}` }],
					details: { error: message },
				};
			}
		},
	});

	// Command for manual use (not LLM-driven)
	pi.registerCommand("telegram-send", {
		description: "Send a message to the Telegram user",
		handler: async (args: string, ctx) => {
			await ensureConfig();

			if (!isTelegramConfigAvailable(config)) {
				ctx.ui.notify("Telegram bot is not configured. Run /telegram-setup first.", "error");
				return;
			}

			if (!args?.trim()) {
				ctx.ui.notify("Please provide a message to send.", "error");
				return;
			}

			try {
				const result = await sendTelegramMessage(config.allowedUserId, args);
				ctx.ui.notify(result, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to send: ${message}`, "error");
			}
		},
	});

	// Inject system prompt so the LLM knows about the capability
	pi.on("before_agent_start", async (event) => {
		const hasTelegramContext = event.system.includes("[telegram]");
		if (hasTelegramContext) {
			return {
				systemPrompt: event.systemPrompt + SYSTEM_PROMPT_SUFFIX,
			};
		}
		// Don't inject if there's no Telegram context - don't pollute normal sessions
		return {};
	});

	// Load config on session start
	pi.on("session_start", async (_event, ctx) => {
		config = await readConfig();
		configChecked = false;
		const available = isTelegramConfigAvailable(config);
		const status = available ? "configured" : "not configured";
		ctx.ui.setStatus("telegram-proactive", `Telegram: ${status}`);
	});

	// Also handle the case where config is already available from the other extension
	pi.on("session_shutdown", async (_event, _ctx) => {
		configChecked = false;
	});
}
