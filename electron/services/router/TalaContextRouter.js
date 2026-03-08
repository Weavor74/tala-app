"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TalaContextRouter = void 0;
var IntentClassifier_1 = require("./IntentClassifier");
var MemoryFilter_1 = require("./MemoryFilter");
var ContextAssembler_1 = require("./ContextAssembler");
var TalaContextRouter = /** @class */ (function () {
    function TalaContextRouter(memoryService) {
        this.memoryService = memoryService;
    }
    /**
     * The primary entry point for context orchestration.
     */
    TalaContextRouter.prototype.process = function (turnId, query, mode) {
        return __awaiter(this, void 0, void 0, function () {
            var intent, isGreetingOnly, retrievalSuppressed, resolved, candidateCount, excludedCount, candidates, filtered, promptBlocks, fallbackUsed, context;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        console.log("[TalaRouter] Processing turn ".concat(turnId, " in mode=").concat(mode));
                        intent = IntentClassifier_1.IntentClassifier.classify(query);
                        isGreetingOnly = intent.class === 'greeting';
                        retrievalSuppressed = isGreetingOnly;
                        console.log("[TalaRouter] Intent: ".concat(intent.class, " | Suppressed: ").concat(retrievalSuppressed, " | Reason: ").concat(intent.precedenceLog || 'standard'));
                        resolved = [];
                        candidateCount = 0;
                        excludedCount = 0;
                        if (!!retrievalSuppressed) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.memoryService.search(query, 10, mode)];
                    case 1:
                        candidates = _a.sent();
                        candidateCount = candidates.length;
                        filtered = MemoryFilter_1.MemoryFilter.filter(candidates, mode, intent);
                        excludedCount = candidateCount - filtered.length;
                        // 5. Contradiction Resolution
                        resolved = MemoryFilter_1.MemoryFilter.resolveContradictions(filtered);
                        return [3 /*break*/, 3];
                    case 2:
                        console.log("[TalaRouter] Retrieval bypassed due to ".concat(intent.class, " intent."));
                        _a.label = 3;
                    case 3:
                        promptBlocks = ContextAssembler_1.ContextAssembler.assemble(resolved, mode, intent.class, retrievalSuppressed).blocks;
                        fallbackUsed = promptBlocks.some(function (b) { return b.header.includes('FALLBACK CONTRACT'); });
                        console.log("[TalaRouter] Routing complete. Approved memories: ".concat(resolved.length, "/").concat(candidateCount));
                        context = {
                            turnId: turnId,
                            resolvedMode: mode,
                            intent: {
                                class: intent.class,
                                confidence: intent.confidence || 0.9,
                                isGreeting: isGreetingOnly
                            },
                            retrieval: {
                                suppressed: retrievalSuppressed,
                                approvedCount: resolved.length,
                                excludedCount: excludedCount
                            },
                            promptBlocks: promptBlocks,
                            fallbackUsed: fallbackUsed,
                            allowedCapabilities: [],
                            blockedCapabilities: [],
                            persistedMode: mode // Defaults to current mode, can be audited later
                        };
                        return [2 /*return*/, context];
                }
            });
        });
    };
    return TalaContextRouter;
}());
exports.TalaContextRouter = TalaContextRouter;
