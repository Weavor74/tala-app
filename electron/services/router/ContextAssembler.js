"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextAssembler = void 0;
var ContextAssembler = /** @class */ (function () {
    function ContextAssembler() {
    }
    /**
     * Assembles sanitized, structured prompt blocks for the Prompt Builder.
     */
    ContextAssembler.assemble = function (memories, mode, intent, retrievalSuppressed) {
        var blocks = [];
        // 1. Memory Block
        if (memories.length > 0) {
            blocks.push({
                header: '[MEMORY CONTEXT]',
                source: 'router',
                priority: 'normal',
                content: memories.map(function (m) { return m.text; }).join('\n'),
                metadata: {
                    memory_ids: memories.map(function (m) { return m.id; }),
                    count: memories.length
                }
            });
        }
        // 2. Persona/Identity Block (Placeholder for future expansion)
        // This could include mode-specific personality traits
        // 2. Fallback Block (SAFE NO-MEMORY CONTRACT)
        // If no memories were found but intent is substantive, inject fallback instructions
        if (memories.length === 0 && !retrievalSuppressed && intent !== 'unknown') {
            blocks.push({
                header: '[FALLBACK CONTRACT — NO MEMORY FOUND]',
                source: 'system',
                priority: 'high',
                content: "You currently have NO approved memories for this ".concat(intent, " query. \nIf the user is asking about a specific fact, preference, or past event, you MUST acknowledge you do not recall it. \nDO NOT invent, philosophize, or hallucinate a memory. Stay in character but stay truthful about your current state of recall.")
            });
        }
        var handoff = {
            mode: mode,
            intent: intent,
            blocks: this.sanitize(blocks),
            retrievalSuppressed: retrievalSuppressed
        };
        return handoff;
    };
    ContextAssembler.sanitize = function (blocks) {
        return blocks.map(function (block) {
            var sanitizedContent = block.content;
            // Remove JSON-like metadata leakage
            sanitizedContent = sanitizedContent.replace(/\[\{.*?\}\]/g, '');
            // Hide internal service names
            sanitizedContent = sanitizedContent.replace(/AgentService|MemoryService|Router|RagService/g, 'System');
            return __assign(__assign({}, block), { content: sanitizedContent.trim() });
        });
    };
    return ContextAssembler;
}());
exports.ContextAssembler = ContextAssembler;
