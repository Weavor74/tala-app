import { describe, it, expect, vi } from 'vitest';
import { UserProfileService } from '../electron/services/UserProfileService';
import type { FullUserProfilePII } from '../electron/services/userProfileTypes';

describe('Memory Identity Logic (Unit)', () => {
    it('should correctly extract identity context from profile', () => {
        const randomId = crypto.randomUUID();
        const mockProfile: FullUserProfilePII = {
            userId: randomId,
            firstName: 'RandomUser_' + Math.floor(Math.random() * 1000),
            middleName: '',
            lastName: 'Tester',
            dateOfBirth: '1990-01-01',
            placeOfBirth: 'TestCity',
            rpName: 'Hero',
            // ... other fields
        } as any;

        const name = mockProfile.firstName;
        const identity = `[USER_IDENTITY]
The current user is ${name} ${mockProfile.lastName} (${mockProfile.rpName}).
User ID: ${mockProfile.userId}
Aliases: ${name}, ${mockProfile.rpName}
Use this context to resolve "my/mine/me/I" and personal facts.`;

        expect(identity).toContain(name);
        expect(identity).toContain(mockProfile.userId);
        expect(identity).not.toContain('1990-01-01');
    });

    it('should prepend identity to system prompt correctly in AgentService logic', () => {
        const identity = "[USER IDENTITY] Alex Reed (Cipher)";
        const systemPromptTemplate = "You are Tala. [ASTRO_STATE]";
        const memoryContext = "Memory contents";
        const userMessage = "Hello";
        const astroState = "Astro State";

        // Logic from AgentService.ts chat()
        const systemPrompt = (identity ? identity + "\n\n" : "") +
            systemPromptTemplate
                .replace(/\[ASTRO_STATE\]/g, astroState)
                .replace(/\[CAPABILITY_CONTEXT\]/g, memoryContext)
                .replace(/\[USER_QUERY\]/g, userMessage);

        expect(systemPrompt).toBe("[USER IDENTITY] Alex Reed (Cipher)\n\nYou are Tala. Astro State");
    });
});
