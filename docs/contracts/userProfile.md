# Contract: userProfile.ts

**Source**: [shared\userProfile.ts](../../shared/userProfile.ts)

## Interfaces

### `Address`
```typescript
interface Address {
    street: string;
    unit: string;
    city: string;
    state: string;
    zip: string;
    country: string;
}
```

### `Job`
```typescript
interface Job {
    company: string;
    role: string;
    startDate: string;
    endDate: string;
    description: string;
}
```

### `School`
```typescript
interface School {
    institution: string;
    degree: string;
    yearGraduated: string;
}
```

### `Contact`
```typescript
interface Contact {
    name: string;
    relation: string;
    contactInfo: string;
    notes: string;
}
```

### `FullUserProfilePII`
```typescript
interface FullUserProfilePII {
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
```

### `UserIdentityContext`
```typescript
interface UserIdentityContext {
    userId: string;
    displayName: string;
    aliases: string[];
}
```

