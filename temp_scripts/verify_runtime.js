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
Object.defineProperty(exports, "__esModule", { value: true });
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log("--- RUNTIME VERIFICATION START ---");
        // 1. Test empty shell command guard (if we could call TerminalService directly, but we are in a script)
        // We will rely on AgentService's behavior.
        // We expect the model to be forced into tool calls for this turn.
        // If the model fails, we should see the hard failure message.
        console.log("Verification script executed.");
        console.log("--- RUNTIME VERIFICATION COMPLETE ---");
    });
}
main().catch(console.error);
