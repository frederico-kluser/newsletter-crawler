// Ponto de entrada dos prompts CONGELADOS da era DeepSeek (ver _shared.mjs p/ o porquê).
// LEGACY_BUILDERS mapeia a função ORIGINAL de src/ → builder, p/ o runner do eval escolher por nome.
import { buildCurateRoundupRequest, buildCurateLeftoverRequest } from './curate.mjs';
import { buildCleanArticleRequest } from './clean.mjs';
import { buildVerifyRecordRequest } from './verify.mjs';
import { buildExtractLinksRequest, buildExtractRoundupLinksRequest } from './links.mjs';
import { buildExtractArticleRequest } from './article-extract.mjs';
import { buildRelevanceRequest, buildRelevanceBatchRequest, buildQuerySpecRequest } from './search.mjs';
import { buildFacetRequest, buildFacetQueryRequest } from './classify.mjs';
import { buildDetectTypeRequest } from './detect-type.mjs';

export { FROZEN_FROM, LEGACY_STAGE_MODELS, legacyStageModel, toCallJSONArgs, parseWith } from './_shared.mjs';
export * from './curate.mjs';
export * from './clean.mjs';
export * from './verify.mjs';
export * from './links.mjs';
export * from './article-extract.mjs';
export * from './search.mjs';
export * from './classify.mjs';
export * from './detect-type.mjs';

export const LEGACY_BUILDERS = Object.freeze({
  curateRoundupItems: buildCurateRoundupRequest,
  curateLeftoverLinks: buildCurateLeftoverRequest,
  cleanArticleContent: buildCleanArticleRequest,
  verifyRecordLLM: buildVerifyRecordRequest,
  extractLinksItemByItem: buildExtractLinksRequest,
  extractRoundupLinks: buildExtractRoundupLinksRequest,
  extractArticleViaLLM: buildExtractArticleRequest,
  judgeRelevance: buildRelevanceRequest,
  judgeRelevanceBatch: buildRelevanceBatchRequest,
  compileQuerySpec: buildQuerySpecRequest,
  classifyFacet: buildFacetRequest,
  mapQueryToFacetTags: buildFacetQueryRequest,
  detectType: buildDetectTypeRequest,
});
