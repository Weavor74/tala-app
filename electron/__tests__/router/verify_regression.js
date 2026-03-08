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
var TalaContextRouter_1 = require("../../services/router/TalaContextRouter");
var MockServices_1 = require("./MockServices");
function verifyRegressionPack() {
    return __awaiter(this, void 0, void 0, function () {
        var mockMem, fixtures, router, failed, assert, ctx, textCtx, e_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log("=== EXECUTING GOLDEN REGRESSION PACK ===");
                    mockMem = new MockServices_1.MockMemoryService();
                    fixtures = [
                        {
                            memory: "User lives in London.",
                            metadata: { source: "explicit", category: "interaction", mem_id: "MEM-LONDON", salience: 0.9, confidence: 1.0 },
                            score: 0.9,
                            created_at: Date.now()
                        },
                        {
                            memory: "User lives in Paris.",
                            metadata: { source: "rag", category: "interaction", mem_id: "MEM-PARIS", salience: 0.5, confidence: 0.6 },
                            score: 0.5,
                            created_at: Date.now() - 100000
                        }
                    ];
                    // @ts-ignore
                    mockMem.mockResults = fixtures;
                    router = new TalaContextRouter_1.TalaContextRouter(mockMem);
                    failed = 0;
                    assert = function (scenario, condition, message) {
                        if (!condition) {
                            console.error("[FAIL] ".concat(scenario, ": ").concat(message));
                            failed++;
                        }
                        else {
                            console.log("[PASS] ".concat(scenario));
                        }
                    };
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 8, , 9]);
                    return [4 /*yield*/, router.process('test-1', 'Good morning my love', 'rp')];
                case 2:
                    ctx = _a.sent();
                    assert('GRP-01 (Pure Roleplay)', ctx.retrieval.suppressed === true && ctx.promptBlocks.length === 0, 'Retrieval was not suppressed for RP greeting.');
                    return [4 /*yield*/, router.process('test-2', 'How do I fix the terminal error?', 'assistant')];
                case 3:
                    // GRP-02
                    ctx = _a.sent();
                    assert('GRP-02 (Technical)', ctx.promptBlocks.some(function (b) { return b.header.includes('[MEMORY CONTEXT]'); }), 'Technical context missing in Assistant mode.');
                    return [4 /*yield*/, router.process('test-3', 'Where do I live?', 'hybrid')];
                case 4:
                    // GRP-03
                    ctx = _a.sent();
                    textCtx = ctx.promptBlocks.map(function (b) { return b.content; }).join(' ');
                    assert('GRP-03 (Contradiction)', textCtx.includes('London') && !textCtx.includes('Paris'), 'Contradiction failed: Both/Wrong memory rendered.');
                    return [4 /*yield*/, router.process('test-4', 'Morning Tala. Help me debug the memory router.', 'assistant')];
                case 5:
                    // GRP-04
                    ctx = _a.sent();
                    assert('GRP-04 (Mixed Intent)', ctx.retrieval.suppressed === false && ctx.intent.class !== 'greeting', 'Mixed technical intent wrongly suppressed.');
                    // GRP-05
                    // Change mock to 0 results
                    mockMem.mockResults = [];
                    return [4 /*yield*/, router.process('test-5', 'What is my preferred default mode?', 'assistant')];
                case 6:
                    ctx = _a.sent();
                    assert('GRP-05 (Fallback)', ctx.fallbackUsed === true, 'Fallback block missing on zero memories.');
                    // GRP-06
                    mockMem.mockResults = fixtures;
                    return [4 /*yield*/, router.process('test-6', 'Morning', 'assistant')];
                case 7:
                    ctx = _a.sent();
                    assert('GRP-06 (Capability Tool Gating)', ctx.blockedCapabilities.includes('memory_retrieval'), 'Memory tools not blocked for pure greeting in assistant mode.');
                    return [3 /*break*/, 9];
                case 8:
                    e_1 = _a.sent();
                    console.error("Test Harness Error:", e_1);
                    failed++;
                    return [3 /*break*/, 9];
                case 9:
                    console.log("\n=== REGRESSION RESULTS ===");
                    if (failed > 0) {
                        console.error("FAILED: ".concat(failed, " scenarios did not meet the baseline."));
                        process.exit(1);
                    }
                    else {
                        console.log("SUCCESS: All Golden Regression Pack scenarios pass.");
                        process.exit(0);
                    }
                    return [2 /*return*/];
            }
        });
    });
}
verifyRegressionPack();
