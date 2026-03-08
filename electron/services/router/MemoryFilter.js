"use strict";
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryFilter = void 0;
var ModePolicyEngine_1 = require("./ModePolicyEngine");
var MemoryFilter = /** @class */ (function () {
    function MemoryFilter() {
    }
    /**
     * Strictly filters candidates based on mode policy, memory status, and intent.
     */
    MemoryFilter.filter = function (candidates, mode, intent) {
        var _this = this;
        return candidates.filter(function (m) {
            var result = _this.evaluate(m, mode, intent);
            if (!result.allowed) {
                console.log("[RouterFilter] EXCLUDE id=".concat(m.id, " reason=").concat(result.reason, " mode=").concat(mode));
            }
            return result.allowed;
        });
    };
    MemoryFilter.evaluate = function (m, mode, intent) {
        var _a, _b, _c;
        // 1. Mode Scope Isolation
        var mRole = ((_a = m.metadata) === null || _a === void 0 ? void 0 : _a.role) || 'core';
        if (mode === 'rp' && mRole !== 'rp' && intent.class !== 'narrative') {
            return { allowed: false, reason: 'wrong_mode_scope (rp_isolation)' };
        }
        if (mode === 'assistant' && mRole === 'rp') {
            return { allowed: false, reason: 'wrong_mode_scope (assistant_isolation)' };
        }
        // 2. Status Policy
        if (m.status === 'archived') {
            return { allowed: false, reason: 'status_archived' };
        }
        if (m.status === 'superseded' && intent.class !== 'technical') {
            return { allowed: false, reason: 'status_superseded' };
        }
        if (m.status === 'contested' && mode !== 'assistant') {
            // Contested memories are risky for RP/Hybrid unless technical
            return { allowed: false, reason: 'status_contested_safety' };
        }
        // 3. Greeting Suppression
        if (intent.class === 'greeting') {
            return { allowed: false, reason: 'intent_greeting_suppression' };
        }
        // 4. Source Policy
        if (!ModePolicyEngine_1.ModePolicyEngine.isSourceAllowed(mode, ((_b = m.metadata) === null || _b === void 0 ? void 0 : _b.source) || 'unknown')) {
            // 'any' in hybrid allows all, but assistant/rp are strict
            if (mode !== 'hybrid') {
                return { allowed: false, reason: "disallowed_source_".concat((_c = m.metadata) === null || _c === void 0 ? void 0 : _c.source) };
            }
        }
        return { allowed: true };
    };
    /**
     * Resolves contradictions by preferring explicit over inferred, or more recent over older.
     */
    MemoryFilter.resolveContradictions = function (candidates) {
        var _a;
        var approved = [];
        var processed = new Set();
        // Sort candidates so explicit comes first, then by recency
        var sorted = __spreadArray([], candidates, true).sort(function (a, b) {
            var _a, _b;
            var aExp = ((_a = a.metadata) === null || _a === void 0 ? void 0 : _a.source) === 'explicit' ? 1 : 0;
            var bExp = ((_b = b.metadata) === null || _b === void 0 ? void 0 : _b.source) === 'explicit' ? 1 : 0;
            if (aExp !== bExp)
                return bExp - aExp;
            return (b.last_reinforced_at || b.created_at) - (a.last_reinforced_at || a.created_at);
        });
        for (var _i = 0, sorted_1 = sorted; _i < sorted_1.length; _i++) {
            var m = sorted_1[_i];
            if (processed.has(m.id))
                continue;
            var rivals = ((_a = m.associations) === null || _a === void 0 ? void 0 : _a.filter(function (a) { return a.type === 'contradicts'; })) || [];
            var isOutranked = false;
            for (var _b = 0, rivals_1 = rivals; _b < rivals_1.length; _b++) {
                var r = rivals_1[_b];
                if (processed.has(r.target_id)) {
                    // A rival has already been approved
                    isOutranked = true;
                    break;
                }
            }
            if (!isOutranked) {
                approved.push(m);
                processed.add(m.id);
            }
        }
        return approved;
    };
    return MemoryFilter;
}());
exports.MemoryFilter = MemoryFilter;
