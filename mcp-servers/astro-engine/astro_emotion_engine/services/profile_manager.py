"""
Profile Manager for Multi-Agent Astrological Identities

Manages persistent storage of agent profiles, each with unique birth data
that defines their astrological emotional personality.
"""

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any
from threading import Lock
from pydantic import BaseModel, Field, validator


class AgentProfile(BaseModel):
    """Persistent agent profile with astrological birth data."""
    
    agent_id: str = Field(..., description="Unique identifier (e.g., 'sage', 'nova')")
    name: str = Field(..., description="Display name for the agent")
    birth_date: str = Field(..., description="ISO 8601 birth date (YYYY-MM-DDTHH:MM:SS)")
    birth_place: str = Field(..., description="Birth city name")
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    
    @validator('agent_id')
    def validate_agent_id(cls, v):
        """Ensure agent_id is lowercase alphanumeric with hyphens/underscores only."""
        if not v:
            raise ValueError("agent_id cannot be empty")
        if not all(c.isalnum() or c in '-_' for c in v):
            raise ValueError("agent_id must be alphanumeric with hyphens/underscores only")
        return v.lower()
    
    @validator('birth_date')
    def validate_birth_date(cls, v):
        """Ensure birth_date is valid ISO 8601 format."""
        try:
            datetime.fromisoformat(v)
        except ValueError:
            raise ValueError(f"birth_date must be ISO 8601 format (YYYY-MM-DDTHH:MM:SS), got: {v}")
        return v


class ProfileManager:
    """
    Manages agent profiles with persistent JSON storage.
    
    Thread-safe CRUD operations for multiple agents sharing one MCP server.
    """
    
    def __init__(self, storage_path: Optional[str] = None):
        """
        Initialize ProfileManager.
        
        Args:
            storage_path: Path to JSON file for profile storage.
                         Defaults to agent_profiles.json in current directory.
                         Can be overridden via AGENT_PROFILES_PATH env var.
        """
        # Determine storage path
        if storage_path is None:
            storage_path = os.getenv('AGENT_PROFILES_PATH', 'agent_profiles.json')
        
        self.storage_path = Path(storage_path)
        self._lock = Lock()
        
        # Ensure storage file exists
        self._ensure_storage()
    
    def _ensure_storage(self):
        """Create storage file if it doesn't exist."""
        if not self.storage_path.exists():
            self.storage_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.storage_path, 'w') as f:
                json.dump({}, f)
    
    def _load_profiles(self) -> Dict[str, Dict[str, Any]]:
        """Load all profiles from storage."""
        with self._lock:
            with open(self.storage_path, 'r') as f:
                return json.load(f)
    
    def _save_profiles(self, profiles: Dict[str, Dict[str, Any]]):
        """Save all profiles to storage."""
        with self._lock:
            with open(self.storage_path, 'w') as f:
                json.dump(profiles, f, indent=2)
    
    def create_profile(
        self,
        agent_id: str,
        name: str,
        birth_date: str,
        birth_place: str
    ) -> AgentProfile:
        """
        Create a new agent profile.
        
        Args:
            agent_id: Unique identifier for the agent
            name: Display name
            birth_date: ISO 8601 birth date
            birth_place: Birth city name
            
        Returns:
            Created AgentProfile
            
        Raises:
            ValueError: If agent_id already exists or validation fails
        """
        # Validate and create profile
        profile = AgentProfile(
            agent_id=agent_id,
            name=name,
            birth_date=birth_date,
            birth_place=birth_place
        )
        
        # Load existing profiles
        profiles = self._load_profiles()
        
        # Check for duplicate
        if profile.agent_id in profiles:
            raise ValueError(f"Agent profile '{agent_id}' already exists")
        
        # Save profile
        profiles[profile.agent_id] = profile.dict()
        self._save_profiles(profiles)
        
        return profile
    
    def get_profile(self, agent_id: str) -> Optional[AgentProfile]:
        """
        Retrieve an agent profile by ID.
        
        Args:
            agent_id: Agent identifier
            
        Returns:
            AgentProfile if found, None otherwise
        """
        profiles = self._load_profiles()
        profile_data = profiles.get(agent_id.lower())
        
        if profile_data:
            return AgentProfile(**profile_data)
        return None
    
    def list_profiles(self) -> List[AgentProfile]:
        """
        List all agent profiles.
        
        Returns:
            List of all AgentProfiles, sorted by agent_id
        """
        profiles = self._load_profiles()
        return sorted(
            [AgentProfile(**data) for data in profiles.values()],
            key=lambda p: p.agent_id
        )
    
    def update_profile(
        self,
        agent_id: str,
        name: Optional[str] = None,
        birth_date: Optional[str] = None,
        birth_place: Optional[str] = None
    ) -> AgentProfile:
        """
        Update an existing agent profile.
        
        Args:
            agent_id: Agent identifier
            name: New name (optional)
            birth_date: New birth date (optional)
            birth_place: New birth place (optional)
            
        Returns:
            Updated AgentProfile
            
        Raises:
            ValueError: If profile not found or validation fails
        """
        profiles = self._load_profiles()
        
        if agent_id.lower() not in profiles:
            raise ValueError(f"Agent profile '{agent_id}' not found")
        
        # Get existing profile
        profile_data = profiles[agent_id.lower()]
        
        # Update fields
        if name is not None:
            profile_data['name'] = name
        if birth_date is not None:
            profile_data['birth_date'] = birth_date
        if birth_place is not None:
            profile_data['birth_place'] = birth_place
        
        # Update timestamp
        profile_data['updated_at'] = datetime.now().isoformat()
        
        # Validate updated profile
        updated_profile = AgentProfile(**profile_data)
        
        # Save
        profiles[agent_id.lower()] = updated_profile.dict()
        self._save_profiles(profiles)
        
        return updated_profile
    
    def delete_profile(self, agent_id: str) -> bool:
        """
        Delete an agent profile.
        
        Args:
            agent_id: Agent identifier
            
        Returns:
            True if deleted, False if not found
        """
        profiles = self._load_profiles()
        
        if agent_id.lower() in profiles:
            del profiles[agent_id.lower()]
            self._save_profiles(profiles)
            return True
        return False
    
    def profile_exists(self, agent_id: str) -> bool:
        """
        Check if a profile exists.
        
        Args:
            agent_id: Agent identifier
            
        Returns:
            True if profile exists, False otherwise
        """
        profiles = self._load_profiles()
        return agent_id.lower() in profiles
