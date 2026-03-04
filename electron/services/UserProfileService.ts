import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4, validate as validateUuid } from 'uuid';
import { FullUserProfilePII, UserIdentityContext } from './userProfileTypes';

/**
 * UserProfileService
 * 
 * Single source of truth for user PII and profile data.
 * Manages persistence, identity context generation, and redaction.
 */
export class UserProfileService {
    private profilePath: string;
    private profile: FullUserProfilePII | null = null;

    constructor(userDataPath: string) {
        this.profilePath = path.join(userDataPath, 'data', 'user_profile.json');
        this.ensureProfileDir(userDataPath);
        this.load();

        // Ensure a valid UUID exist immediately on startup
        if (!this.profile || !validateUuid(this.profile.userId)) {
            console.log('[UserProfileService] No valid userId found on boot. Generating fresh UUID...');
            this.ensureValidProfile();
        }
    }

    private ensureProfileDir(userDataPath: string) {
        const dataDir = path.join(userDataPath, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
    }

    /**
     * Loads the profile from disk.
     */
    private load() {
        try {
            if (fs.existsSync(this.profilePath)) {
                this.profile = JSON.parse(fs.readFileSync(this.profilePath, 'utf-8'));
            }
        } catch (e) {
            console.error('[UserProfileService] Error loading profile:', e);
        }
    }

    /**
     * Ensures we have a profile with a valid UUID.
     */
    private ensureValidProfile() {
        const now = new Date().toISOString();
        const existing = (this.profile || {}) as Partial<FullUserProfilePII>;

        const validProfile: FullUserProfilePII = {
            userId: validateUuid(existing.userId || '') ? existing.userId! : uuidv4(),
            firstName: existing.firstName || '',
            middleName: existing.middleName || '',
            lastName: existing.lastName || '',
            dateOfBirth: existing.dateOfBirth || '',
            placeOfBirth: existing.placeOfBirth || '',
            rpName: existing.rpName || '',
            address: existing.address || { street: '', unit: '', city: '', state: '', zip: '', country: '' },
            email: existing.email || '',
            phone: existing.phone || '',
            workHistory: existing.workHistory || [],
            schools: existing.schools || [],
            hobbies: existing.hobbies || [],
            network: existing.network || [],
            schemaVersion: 1,
            lastUpdated: now
        };

        this.save(validProfile);
    }

    /**
     * Persists the profile to disk.
     */
    public save(profile: FullUserProfilePII): void {
        try {
            // Validate UUID before saving
            if (!validateUuid(profile.userId)) {
                console.warn('[UserProfileService] Invalid UUID detected during save. Regenerating...');
                profile.userId = uuidv4();
            }

            this.profile = {
                ...profile,
                lastUpdated: new Date().toISOString(),
                schemaVersion: profile.schemaVersion || 1
            };

            fs.writeFileSync(this.profilePath, JSON.stringify(this.profile, null, 2));
            console.log('[UserProfileService] Profile saved successfully.');
        } catch (e) {
            console.error('[UserProfileService] Error saving profile:', e);
            throw e;
        }
    }

    /**
     * Returns the full profile (sensitive).
     */
    public getFullProfile(): FullUserProfilePII | null {
        return this.profile;
    }

    /**
     * Returns a minimal identity context safe for prompts.
     * Guaranteed to return a valid UUID for the user.
     */
    public getIdentityContext(): UserIdentityContext {
        if (!this.profile || !validateUuid(this.profile.userId)) {
            // This should ideally not be reachable due to the check in the constructor
            // but we provide a safety bridge.
            this.ensureValidProfile();
        }

        const aliases = [this.profile!.firstName, this.profile!.rpName].filter(Boolean) as string[];

        return {
            userId: this.profile!.userId,
            displayName: this.profile!.firstName || 'User',
            aliases: Array.from(new Set(aliases))
        };
    }

    /**
     * Redacts PII from a profile object for logging purposes.
     */
    public static redactPII(profile: any): any {
        if (!profile) return null;
        return {
            userId: profile.userId,
            hasFirstName: !!profile.firstName,
            hasLastName: !!profile.lastName,
            hasDOB: !!profile.dateOfBirth,
            schemaVersion: profile.schemaVersion,
            lastUpdated: profile.lastUpdated
        };
    }
}
