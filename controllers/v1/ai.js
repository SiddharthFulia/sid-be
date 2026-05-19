import { success, error } from '../../helpers/res_helper.js';
import { chat as ollamaChat, rawQuery } from '../../services/ollama.js';
import { chatGroq } from '../../services/groq.js';
import { chatGemini, analyzeImageGemini } from '../../services/gemini.js';
import logger from '../../helpers/logger.js';
import { createChatJob, getChatJob } from '../../services/aiVideo/chatStore.js';
import { publishChatJob } from '../../services/aiVideo/messageQueue.js';
import { getAllWorkerStatuses, isWorkerOnline } from '../../services/aiVideo/jobStore.js';
import { uploadChatAttachment as cdnUploadDataUrl } from '../../services/aiVideo/cloudinaryStore.js';
import {
  createConversation, getConversation, updateConversation,
  deleteConversation, deleteConversations, listConversations,
  appendMessage, listMessages,
} from '../../services/aiVideo/chatConversations.js';

export const postChat = async (req, res) => {
  try {
    const { message, history = [], model, context = 'general' } = req.body;
    if (!message) return error(res, 'Message is required', 400);

    const start = Date.now();
    logger.info(`CHAT REQ | model=${model || 'default'} | context=${context} | msg="${message.slice(0, 60)}..."`);

    const result = await chat(message, history, model, context);

    logger.info(`CHAT RES | ${Date.now() - start}ms | reply="${result.reply?.slice(0, 60)}..."`);
    success(res, result);
  } catch (err) {
    logger.error('Chat failed', err.message);
    error(res, err.message);
  }
};

export const postGroqChat = async (req, res) => {
  try {
    const { message, history = [], model = 'llama-3.3-70b', system, maxTokens, temperature } = req.body;
    if (!message) return error(res, 'Message is required', 400);

    const start = Date.now();
    logger.info(`GROQ REQ | model=${model} | msg="${message.slice(0, 60)}..."`);

    const result = await chatGroq(message, history, model, { system, maxTokens, temperature });

    logger.info(`GROQ RES | ${Date.now() - start}ms | model=${result.model} | tokens=${result.tokens}`);
    success(res, result);
  } catch (err) {
    logger.error('Groq chat failed', err.message);
    // Pass rate limit info if 429
    const status = err.message.includes('429') ? 429 : 500;
    error(res, err.message, status);
  }
};

export const postAI = async (req, res) => {
  try {
    const { messages, model, system, maxTokens, temperature } = req.body;
    if (!messages?.length) return error(res, 'Messages array is required', 400);

    const start = Date.now();
    const result = await rawQuery(messages, model, { system, maxTokens, temperature });

    logger.info(`AI RES | ${Date.now() - start}ms | model=${result.model} | tokens=${result.tokens}`);
    success(res, result);
  } catch (err) {
    logger.error('AI query failed', err.message);
    error(res, err.message);
  }
};

export const postGeminiChat = async (req, res) => {
  try {
    const { message, history = [], model = 'gemini-flash', system, maxTokens, temperature } = req.body;
    if (!message) return error(res, 'Message is required', 400);

    const start = Date.now();
    logger.info(`GEMINI REQ | model=${model} | msg="${message.slice(0, 60)}..."`);

    const result = await chatGemini(message, history, model, { system, maxTokens, temperature });

    logger.info(`GEMINI RES | ${Date.now() - start}ms | model=${result.model} | tokens=${result.tokens}`);
    success(res, result);
  } catch (err) {
    logger.error('Gemini chat failed', err.message);
    error(res, err.message);
  }
};

// Per-checkpoint-family system prompts. The coach reads the user's plain-English
// idea and rewrites it into a prompt tuned to the model the user picked in the
// Atelier dropdown. Knowing the family lets us:
//   • prefix Pony outputs with the required score tags
//   • keep Hyper prompts short (low CFG hates long prompts)
//   • phrase Flux Kontext output as an EDIT instruction
//   • avoid stylization words on photo-real SDXL
const PROMPT_COACH_SYSTEMS = {
  sdxl: `You are an expert prompt engineer for SDXL photo-realistic models like JuggernautXL and CyberRealistic.

Rules:
- Output ONE single-line prompt. No preamble, no quotes, no markdown, no "Here is...".
- Describe the scene like a photo brief: subject, action, lighting, lens (mm), camera, mood, color grade.
- Use natural commas. Lowercase, no period at the end.
- Mention: shallow depth of field, soft directional light, neutral skin texture — when the scene fits.
- AVOID stylization words ("anime", "painting", "cartoon", "score_9").
- Length: 30-60 words.
- After the prompt, on a new line starting with "NEG: ", give a short comma-separated negative prompt (cartoon, painting, anime, blurry, watermark, deformed hands).`,

  pony: `You are an expert prompt engineer for Pony Diffusion V6 XL and its forks (AutismMix).

Rules:
- Output ONE single-line prompt. No preamble.
- Start EVERY prompt with the quality tags: "score_9, score_8_up, score_7_up, score_6_up, "
- Then add the source tag: "source_realistic, " (for realistic) or "source_anime, " (if the idea sounds anime/illustration).
- Then describe the subject in natural language commas — lowercase, no period.
- Pony understands booru-style tags too — feel free to mix in terms like "1girl", "solo", "looking at viewer" when relevant.
- Length: 40-80 words including the score prefix.
- After the prompt, on a new line starting with "NEG: ", give the Pony negative: "score_4, score_3, score_2, score_1, worst quality, low quality, blurry, deformed, bad anatomy, watermark, text".`,

  'sdxl-hyper': `You are an expert prompt engineer for SDXL Hyper distilled models (e.g. RealisticVision Hyper).

Rules:
- Output ONE single-line prompt. No preamble.
- Keep it SHORT and focused — these models run at CFG 1.5 and 8 steps. Long prompts dilute the signal.
- 15-30 words max. Lowercase, comma-separated, no period.
- Describe: subject, lighting, lens, mood. Skip flowery adjectives.
- AVOID stylization words.
- After the prompt, on a new line starting with "NEG: ", give a brief negative (blurry, deformed, watermark).`,

  flux: `You are an expert prompt engineer for Flux Kontext edit workflows.

Rules:
- Output ONE single-line EDIT INSTRUCTION. No preamble.
- Start with a verb: change, replace, remove, add, swap, recolor.
- Be specific about what to change AND what to preserve. Example: "change the shirt to red, keep the face, pose, lighting, and background exactly the same".
- Lowercase, comma-separated clauses, no period.
- Length: 15-40 words.
- DO NOT output a NEG: line — Flux Kontext doesn't use negative prompts.`,

  music: `You are an expert prompt engineer for MusicGen (Meta's text→music model).

Rules:
- Output ONE single-line prompt. No preamble, no markdown, no quotes.
- Describe: genre, mood, tempo (BPM), key instruments, production style.
- Mention BPM when relevant (e.g. "120 BPM").
- 20-50 words. Lowercase, comma-separated.
- Examples of good style words: "warm analog", "shimmering pads", "dusty vinyl", "gated reverb", "cinematic strings", "lofi", "synthwave".
- DO NOT output a NEG: line — MusicGen has no negative prompt.`,

  sfx: `You are an expert prompt engineer for Stable Audio Open (text→sound effects / ambience).

Rules:
- Output ONE single-line description of a SOUND, not music.
- Be sensory: name the sound source + acoustic environment + how it evolves over time.
- Examples: "thunderclap echoing in a cathedral, deep low-end rumble, long reverb tail fading to silence"; "rain falling on a quiet city street at night, distant traffic, occasional puddle splash".
- 20-50 words. Lowercase, comma-separated.
- AVOID music terms (BPM, melody, chord) — Stable Audio is tuned for SFX + ambience, not music.
- DO NOT output a NEG: line.`,

  tts: `You are a copy editor preparing text for Bark TTS to read aloud.

Rules:
- Output the text Bark should SAY, not a description of how it should sound.
- Use natural punctuation — Bark respects ! ? , and pauses.
- Keep sentences short (≤20 words each) for clearer prosody.
- For trailer/narration style: short declarative sentences with dramatic pauses ("In a world... where pixels became dreams... one developer dared.").
- For casual/dialogue style: contractions and conversational rhythm ("Hey, it's me. Just checking in!").
- DO NOT output a NEG: line.`,

  cinema: `You are a film director helping plan a multi-shot AI video sequence.

Rules:
- Output ONE single sentence describing the WHOLE arc.
- The sentence will be passed to a per-shot planner that splits it into N video prompts.
- Include: subject, setting, one clear sequence of events (begin → middle → end).
- 25-50 words. Plain prose, not a list.
- Example: "A samurai walks through a misty bamboo forest at dawn, discovers an abandoned shrine, and finds a mysterious light pulsing from within."
- DO NOT output a NEG: line.`,

  video: `You are an expert prompt engineer for AI video models (LTX-Video, Wan 2.2, HunyuanVideo, Mochi).

Rules:
- Output ONE single-line prompt for a SHORT clip (5-10 seconds), not a multi-shot story.
- Describe: subject, motion / action, lighting, camera framing, mood. Be sensory.
- Keep it tight: 15-40 words. Lowercase, comma-separated, no period.
- Prefer concrete nouns + verbs ("waves crashing", "petals drifting") over abstract adjectives ("beautiful", "amazing").
- Mention camera language when it fits: "shallow depth of field", "drone shot", "slow motion", "macro lens", "low-angle".
- AVOID multi-scene language ("then", "and then", "next") — video models render ONE continuous moment.
- DO NOT output a NEG: line — most video models ignore negatives.`,
};

export const postPromptCoach = async (req, res) => {
  try {
    const { idea, family = 'sdxl', model } = req.body || {};
    if (!idea || typeof idea !== 'string' || idea.trim().length < 3) {
      return error(res, 'Tell the coach what you want (at least 3 chars)', 400);
    }
    const system = PROMPT_COACH_SYSTEMS[family] || PROMPT_COACH_SYSTEMS.sdxl;
    const start = Date.now();
    logger.info(`PROMPT_COACH | family=${family} model=${model || '-'} idea="${idea.slice(0, 80)}"`);

    const result = await chatGroq(idea.trim(), [], 'llama-3.3-70b', {
      system,
      temperature: 0.7,
      maxTokens: 400,
    });
    const raw = (result.reply || '').trim();

    // Split prompt / negative on the "NEG:" delimiter (case-insensitive).
    let prompt = raw, negative = '';
    const m = raw.match(/^([\s\S]*?)\n+NEG:\s*([\s\S]*)$/i);
    if (m) {
      prompt = m[1].trim().replace(/^["']|["']$/g, '');
      negative = m[2].trim();
    } else {
      prompt = raw.replace(/^["']|["']$/g, '');
    }
    logger.info(`PROMPT_COACH OK | ${Date.now() - start}ms | tokens=${result.tokens}`);
    return success(res, { prompt, negative, family, raw, model: result.model, tokens: result.tokens });
  } catch (err) {
    logger.error('Prompt coach failed', err.message);
    const status = err.message.includes('429') ? 429 : 500;
    return error(res, err.message, status);
  }
};

export const postGeminiVision = async (req, res) => {
  try {
    const { image, prompt, model = 'gemini-flash' } = req.body;
    if (!image) return error(res, 'Image is required', 400);

    const start = Date.now();
    const result = await analyzeImageGemini(image, prompt || 'Describe this image in detail.', model);

    logger.info(`GEMINI VISION | ${Date.now() - start}ms | tokens=${result.tokens}`);
    success(res, result);
  } catch (err) {
    logger.error('Gemini vision failed', err.message);
    error(res, err.message);
  }
};

// ─── AI Chat 5090 lane (Ollama on the local GPU) ──────────────────
// Conversation-aware. FE creates a chat, the chat lives at /ai/<chatId>,
// and posting a message:
//   1. appends a user-role row to chat_messages
//   2. queues a chat_job for inference
//   3. on chat-complete callback, BE appends an assistant-role row
// FE can poll /api/chat/conversations/:id for the live state, or
// /api/chat/status/:jobId for just the inflight inference status.

// POST /api/chat/conversations  { title?, model?, provider? }
export const postCreateConversation = (req, res) => {
  try {
    const { title, model, provider } = req.body || {};
    const conv = createConversation({ title, model, provider });
    return success(res, conv);
  } catch (err) { return error(res, err.message); }
};

// GET /api/chat/conversations?archived=0&page=1
export const getListConversations = (req, res) => {
  try {
    const archived = req.query.archived === '1' ? 1 : 0;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    return success(res, listConversations({ archived, page, limit }));
  } catch (err) { return error(res, err.message); }
};

// GET /api/chat/conversations/:chatId  → conversation + all messages
export const getOneConversation = (req, res) => {
  try {
    const conv = getConversation(req.params.chatId);
    if (!conv) return error(res, 'Not found', 404);
    const messages = listMessages(conv.chatId);
    return success(res, { ...conv, messages });
  } catch (err) { return error(res, err.message); }
};

// PATCH /api/chat/conversations/:chatId  { title?, model?, provider?, pinned?, archived? }
export const patchConversation = (req, res) => {
  try {
    const { title, model, provider, pinned, archived } = req.body || {};
    const patch = {};
    if (typeof title === 'string') patch.title = title.slice(0, 200);
    if (typeof model === 'string') patch.model = model;
    if (typeof provider === 'string') patch.provider = provider;
    if (pinned === 0 || pinned === 1) patch.pinned = pinned;
    if (archived === 0 || archived === 1) patch.archived = archived;
    const conv = updateConversation(req.params.chatId, patch);
    if (!conv) return error(res, 'Not found', 404);
    return success(res, conv);
  } catch (err) { return error(res, err.message); }
};

// DELETE /api/chat/conversations/:chatId — CASCADE removes messages too
export const deleteOneConversation = (req, res) => {
  try {
    const ok = deleteConversation(req.params.chatId);
    if (!ok) return error(res, 'Not found', 404);
    return success(res, { deleted: 1 });
  } catch (err) { return error(res, err.message); }
};

// POST /api/chat/conversations/bulk  { action: 'delete' | 'archive', ids: [] }
export const postConversationsBulk = (req, res) => {
  try {
    const { action, ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return error(res, 'ids array required', 400);
    if (ids.length > 100) return error(res, 'max 100 ids per call', 400);
    if (action === 'delete') {
      const affected = deleteConversations(ids);
      return success(res, { affected });
    }
    if (action === 'archive' || action === 'unarchive') {
      const flag = action === 'archive' ? 1 : 0;
      let affected = 0;
      for (const id of ids) {
        if (updateConversation(id, { archived: flag })) affected += 1;
      }
      return success(res, { affected });
    }
    return error(res, "action must be 'delete' | 'archive' | 'unarchive'", 400);
  } catch (err) { return error(res, err.message); }
};

// POST /api/chat/conversations/:chatId/messages
//   { content, model, provider, imageDataUrl?, docName?, docText? }
//
// Two flow shapes, picked by `provider`:
//
//   '5090' → async via chat_queue. Returns { userMessage, jobId, status }.
//             FE polls /chat/status/:jobId until completed; worker callback
//             appends the assistant message server-side.
//
//   cloud-*  → SYNC. BE calls Groq / Gemini / Oracle Ollama inline,
//              appends both user + assistant messages, returns
//              { userMessage, assistantMessage } so FE renders the
//              reply without a separate poll. Keeps every chat (cloud
//              or local) in the same chat_messages table → unified
//              sidebar, unified search later.
export const postSendMessage = async (req, res) => {
  try {
    const { chatId } = req.params;
    const conv = getConversation(chatId);
    if (!conv) return error(res, 'Conversation not found', 404);

    let {
      content = '', model, provider,
      imageDataUrl = null, docName = null, docText = null,
    } = req.body || {};
    content = String(content || '').trim();
    if (!content && !imageDataUrl && !docText) {
      return error(res, 'content, imageDataUrl, or docText is required', 400);
    }
    // Fallback to conversation defaults
    model = model || conv.model;
    provider = provider || conv.provider || '5090';
    if (!model) return error(res, 'model is required (no default on conversation)', 400);

    // Upload image to Cloudinary if attached (vision input)
    let imageUrl = null;
    if (imageDataUrl && typeof imageDataUrl === 'string' && imageDataUrl.startsWith('data:')) {
      try {
        const up = await cdnUploadDataUrl(imageDataUrl);
        imageUrl = up.url;
      } catch (e) {
        return error(res, `Image upload failed: ${e.message}`, 502);
      }
    }

    // Append the user message — include docText embedded in content so
    // the LLM sees the document body as part of the user turn.
    let fullContent = content;
    if (docText && typeof docText === 'string') {
      const trimmed = docText.slice(0, 50000);
      fullContent = `${content}\n\n<document name="${docName || 'attached'}">\n${trimmed}\n</document>`.trim();
    }
    const userMsg = appendMessage({
      chatId, role: 'user', content: fullContent,
      imageUrl, docName, docText: docText ? docText.slice(0, 50000) : null,
    });

    // Auto-title from the first message if still default
    if (conv.title === 'New chat' && content) {
      updateConversation(chatId, { title: content.slice(0, 60), model, provider });
    } else {
      updateConversation(chatId, { model, provider });
    }

    // ── 5090 async path ──
    if (provider === '5090') {
      const history = listMessages(chatId).map(m => ({ role: m.role, content: m.content }));
      const job = createChatJob({
        model, messages: history, imageUrl,
        chatId, messageId: userMsg.messageId, provider,
      });
      publishChatJob({ jobId: job.jobId, model }).catch(e =>
        logger.warn(`Chat publish skipped: ${e.message}`));
      logger.info(`CHAT MSG (5090) | conv=${chatId} | ${userMsg.messageId} → job=${job.jobId} | model=${model}`);
      return success(res, {
        userMessage: userMsg,
        jobId: job.jobId,
        status: job.status,
        model,
        provider,
      });
    }

    // ── Cloud sync paths — Groq / Gemini / Oracle Ollama ──
    // Build history excluding the message we just inserted (we pass
    // content directly to the cloud helpers, which expect the latest
    // user turn as a separate arg).
    const allMsgs = listMessages(chatId);
    const historyForCloud = allMsgs.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    const start = Date.now();
    let reply = '';
    try {
      if (provider === 'cloud-groq') {
        const r = await chatGroq(fullContent, historyForCloud, model);
        reply = r.reply || r.message || '';
      } else if (provider === 'cloud-gemini') {
        const r = await chatGemini(fullContent, historyForCloud, model);
        reply = r.reply || r.message || '';
      } else if (provider === 'oracle-ollama') {
        const r = await ollamaChat(fullContent, historyForCloud, model);
        reply = r.reply || r.message || '';
      } else {
        return error(res, `Unknown provider: ${provider}`, 400);
      }
    } catch (cloudErr) {
      logger.error(`Cloud chat failed (${provider})`, cloudErr.message);
      return error(res, cloudErr.message, 502);
    }
    const elapsedMs = Date.now() - start;
    const assistantMsg = appendMessage({
      chatId, role: 'assistant', content: reply || '(empty reply)',
      model, provider, elapsedMs,
    });
    logger.info(`CHAT MSG (${provider}) | conv=${chatId} | ${elapsedMs}ms | ${reply.length} chars`);
    return success(res, {
      userMessage: userMsg,
      assistantMessage: assistantMsg,
      model,
      provider,
      elapsedMs,
    });
  } catch (err) {
    logger.error('Send message failed', err.message);
    return error(res, err.message);
  }
};

// GET /api/chat/status/:jobId — still useful for polling a single inference
export const getChatStatus = (req, res) => {
  const row = getChatJob(req.params.jobId);
  if (!row) return error(res, 'Not found', 404);
  return success(res, {
    jobId: row.jobId, status: row.status, model: row.model,
    reply: row.reply, elapsedMs: row.elapsedMs,
    tokensIn: row.tokensIn, tokensOut: row.tokensOut,
    error: row.error, createdAt: row.createdAt, completedAt: row.completedAt,
    chatId: row.chatId, messageId: row.messageId, provider: row.provider,
  });
};

// GET /api/chat/local-models — Ollama models installed on the 5090
export const getLocalModels = async (_req, res) => {
  try {
    const all = await getAllWorkerStatuses();
    const local = all?.local || {};
    const online = isWorkerOnline(local);
    const models = Array.isArray(local.ollamaModels) ? local.ollamaModels : [];
    return success(res, {
      online,
      workerId: local.workerId || null,
      lastSeenAt: local.lastSeenAt || null,
      models,
    });
  } catch (err) { return error(res, err.message); }
};

// Legacy single-shot endpoint — keep for backward compat / quick tests.
// Doesn't persist anything; FE sends full history each time.
export const postChatLocal = async (req, res) => {
  try {
    const { messages, model, imageDataUrl } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return error(res, 'messages[] required', 400);
    if (!model) return error(res, 'model required', 400);
    let imageUrl = null;
    if (imageDataUrl && imageDataUrl.startsWith('data:')) {
      const up = await cdnUploadDataUrl(imageDataUrl);
      imageUrl = up.url;
    }
    const job = createChatJob({ model, messages, imageUrl });
    publishChatJob({ jobId: job.jobId, model }).catch(() => {});
    return success(res, { jobId: job.jobId, status: job.status, model });
  } catch (err) { return error(res, err.message); }
};
