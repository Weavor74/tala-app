/**
 * User Identity & PII Type Definitions
 * 
 * Shared schemas for the "Deep Profile" and "Identity Context".
 * These types form the contract between the high-confidentiality renderer root
 * and the backend PII handling services.
 * 
 * **Security Context:**
 * - `FullUserProfilePII` is never sent to LLMs; it is restricted to local storage.
 * - `UserIdentityContext` is the "prompt-safe" variant used for agent character grounding.
 */

export interface Address {
    street: string;
    unit: string;
    city: string;
    state: string;
    zip: string;
    country: string;
}

export interface Job {
    company: string;
    role: string;
    startDate: string;
    endDate: string;
    description: string;
}

export interface School {
    institution: string;
    degree: string;
    yearGraduated: string;
}

export interface Contact {
    name: string;
    relation: string;
    contactInfo: string;
    notes: string;
}

/**
 * FullUserProfilePII
 * 
 * The complete, sensitive user profile containing all PII.
 * Sourced from UserProfile.tsx / data/user_profile.json.
 */
export interface FullUserProfilePII {
    userId: string;              // Stable UUID
    firstName: string;
    middleName: string;
    lastName: string;
    dateOfBirth: string;         // ISO YYYY-MM-DD
    placeOfBirth: string;
    rpName: string;              // Roleplay/Character Name
    address: Address;
    email: string;
    phone: string;
    workHistory: Job[];
    schools: School[];
    hobbies: string[];
    network: Contact[];
    schemaVersion: number;
    lastUpdated: string;         // ISO Timestamp
}

/**
 * UserIdentityContext
 * 
 * Minimal, non-sensitive identity context safe for injection into LLM prompts.
 * DOB is EXCLUDED here; it should be passed to Astro Engine separately.
 */
export interface UserIdentityContext {
    userId: string;              // Stable UUID for memory resolution
    displayName: string;         // Preferred name for the agent to use
    aliases: string[];           // [firstName, rpName, etc.]
}
