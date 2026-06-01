// AI chat + assist endpoints — Ollama (local + Oracle), Groq, Gemini,
// conversation persistence, prompt coach. The 5090 lane uses the
// queued chat_jobs pattern; cloud lanes return inline.

import { Router } from 'express';
import { requireVault } from '../../services/auth/vault.js';
import {
  postChat, postAI, postGroqChat, postGeminiChat, postGeminiVision, postPromptCoach,
  postChatLocal, getChatStatus, getLocalModels,
  postCreateConversation, getListConversations, getOneConversation,
  patchConversation, deleteOneConversation, postConversationsBulk, postSendMessage,
  postCompactConversation, postCompactFinalize,
} from '../../controllers/ai/index.js';

const router = Router();

// AI (Ollama local — on Oracle BE)
router.post('/chat', postChat);
router.post('/ai',   postAI);

// AI Chat 5090 lane — Ollama running on the home RTX 5090
router.post('/chat/local',          postChatLocal);          // legacy single-shot
router.get( '/chat/status/:jobId',  getChatStatus);
router.get( '/chat/local-models',   getLocalModels);

// Conversation-aware multi-turn chat with persistence
router.post(  '/chat/conversations',                          postCreateConversation);
router.get(   '/chat/conversations',                          getListConversations);
// §75 — destructive chat ops require vault auth.
router.post(  '/chat/conversations/bulk',                     requireVault, postConversationsBulk);
router.get(   '/chat/conversations/:chatId',                  getOneConversation);
router.patch( '/chat/conversations/:chatId',                  patchConversation);
router.delete('/chat/conversations/:chatId',                  requireVault, deleteOneConversation);
router.post(  '/chat/conversations/:chatId/messages',         postSendMessage);
router.post(  '/chat/conversations/:chatId/compact',          postCompactConversation);
router.post(  '/chat/conversations/:chatId/compact/finalize', postCompactFinalize);

// Cloud lanes
router.post('/groq',          postGroqChat);
// §76 follow-up — Gemini text + vision now route through Groq under the
// hood (the controllers detect GEMINI_ENABLED and pick Groq when it's off).
// FE keeps the same `/api/gemini` + `/api/gemini/vision` URLs and payload
// shapes — responses are tagged `provider: 'gemini-via-groq'` so the FE
// can tell. To re-enable native Gemini: set GEMINI_ENABLED=1 in the BE
// .env and pm2 restart sid-be — the controllers will switch back without
// any code change.
//
// Note: image-out (`enhanceImageGemini`, used by /api/image-enhance) is
// NOT covered by this fallback — Groq has no image-output model. That
// endpoint still requires GEMINI_ENABLED=1 to function.
router.post('/gemini',        postGeminiChat);
router.post('/gemini/vision', postGeminiVision);

// Prompt coach — turns a plain-English idea into a model-tuned image prompt.
router.post('/ai/prompt-coach', postPromptCoach);

export default router;
