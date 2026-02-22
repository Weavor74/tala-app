/**
 * User Profile Data Models
 *
 * Defines the TypeScript interfaces and default values for the user's
 * "deep profile" — a comprehensive personal data sheet that Tala uses
 * to personalize interactions. Stored as `user_profile.json` on disk.
 *
 * Used by: `UserProfile.tsx` (editor UI), `AgentService` (context injection).
 */

/**
 * Physical mailing address.
 * Used within `UserDeepProfile.address`.
 */
export interface Address {
    street: string;
    unit: string;
    city: string;
    state: string;
    zip: string;
    country: string;
}

/**
 * A single entry in the user's work history.
 * Used as items in `UserDeepProfile.workHistory`.
 */
export interface Job {
    company: string;
    role: string;
    startDate: string;
    endDate: string;
    description: string;
}

/**
 * A single entry in the user's education history.
 * Used as items in `UserDeepProfile.schools`.
 */
export interface School {
    institution: string;
    degree: string;
    yearGraduated: string;
}

/**
 * A person in the user's social/professional network.
 * Used as items in `UserDeepProfile.network`.
 */
export interface Contact {
    /** Display name of the contact. */
    name: string;
    /** Relationship to the user (e.g. "Friend", "Colleague", "Family"). */
    relation: string;
    /** Phone number or email address. */
    contactInfo: string;
    /** Free-form notes about this contact. */
    notes: string;
}

/**
 * The complete user profile data model.
 *
 * Sections:
 * - **Identity** — Name, DOB, place of birth, roleplay alias.
 * - **Contact** — Address, email, phone.
 * - **Professional** — Work history entries.
 * - **Education** — School/degree entries.
 * - **Personal** — Hobbies (string array).
 * - **Social** — Network of contacts.
 */
export interface UserDeepProfile {
    // ── Identity ──────────────────────────────────────────
    firstName: string;
    middleName: string;
    lastName: string;
    dateOfBirth: string;
    placeOfBirth: string;
    /** Roleplay/character name for in-universe interactions. */
    rpName: string;

    // ── Contact ───────────────────────────────────────────
    address: Address;
    email: string;
    phone: string;

    // ── Professional ──────────────────────────────────────
    workHistory: Job[];

    // ── Education ─────────────────────────────────────────
    schools: School[];

    // ── Personal ──────────────────────────────────────────
    /** Stored as an array; typically edited as comma-separated tags. */
    hobbies: string[];

    // ── Social ────────────────────────────────────────────
    network: Contact[];
}

/**
 * Empty default profile used when no saved profile is found on disk.
 * Pre-populates all fields to avoid null-reference errors in the UI.
 */
export const DEFAULT_PROFILE: UserDeepProfile = {
    firstName: '',
    middleName: '',
    lastName: '',
    dateOfBirth: '',
    placeOfBirth: '',
    rpName: '',
    address: { street: '', unit: '', city: '', state: '', zip: '', country: '' },
    email: '',
    phone: '',
    workHistory: [],
    schools: [],
    hobbies: [],
    network: []
};
