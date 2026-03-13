/**
 * User Identity & PII Type Definitions
 * 
 * Shared schemas for the "Deep Profile" and "Identity Context".
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
 */
export interface FullUserProfilePII {
    userId: string;
    firstName: string;
    middleName: string;
    lastName: string;
    dateOfBirth: string;
    placeOfBirth: string;
    rpName: string;
    address: Address;
    email: string;
    phone: string;
    workHistory: Job[];
    schools: School[];
    hobbies: string[];
    network: Contact[];
    schemaVersion: number;
    lastUpdated: string;
}

/**
 * UserIdentityContext
 * 
 * Minimal, non-sensitive identity context safe for injection into LLM prompts.
 */
export interface UserIdentityContext {
    userId: string;
    displayName: string;
    aliases: string[];
}
