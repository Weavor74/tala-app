"""
Astro Emotion Engine — MCP Server

FastMCP server exposing the Astro Emotion Engine as MCP tools.
Provides 7 tools for emotional state computation and agent profile management:

  - ``get_emotional_state``  — Compute current emotional state for an agent or ad-hoc birth data.
  - ``create_agent_profile`` — Persist a new agent with birth chart data.
  - ``list_agent_profiles``  — List all registered agent profiles.
  - ``get_agent_profile``    — Get detailed info for an agent.
  - ``update_agent_profile`` — Modify an existing agent's data.
  - ``delete_agent_profile`` — Permanently remove an agent profile.
  - ``get_current_state``    — Quick world-transit emotional snapshot (no birth data).

Agent profiles are stored as JSON on disk via ``ProfileManager``.
Charts are computed on-the-fly via ``ChartFactory`` + ``AstroEmotionEngine``.
"""

from datetime import datetime
import json
import logging
from typing import Any
from mcp.server.fastmcp import FastMCP
from astro_emotion_engine.services.chart_factory import ChartFactory
from astro_emotion_engine.services.profile_manager import ProfileManager
from astro_emotion_engine.engine import AstroEmotionEngine
from .schemas.request import EmotionRequest

# Initialize FastMCP Server
mcp = FastMCP("AstroEmotionEngine")

# Services (instantiated at module level for simplicity in MVP)
chart_factory = ChartFactory()
engine = AstroEmotionEngine()
profile_manager = ProfileManager()

@mcp.tool()
def get_agent_emotional_state(agent_id: str, context_prompt: str = "") -> str:
    """
    Calculates the astrological emotional state for an agent using their registered profile.
    
    Args:
        agent_id: Agent profile ID (e.g. "sage")
        context_prompt: Optional context (e.g. "User is asking about career")
        
    Returns:
        Formatted string containing System Instructions, Style Guide, and Emotional Vector.
    """
    try:
        profile = profile_manager.get_profile(agent_id)
        if not profile:
            available = profile_manager.list_profiles()
            available_ids = [p.agent_id for p in available]
            return (
                f"❌ Error: Agent profile '{agent_id}' not found.\n\n"
                f"Available profiles: {', '.join(available_ids) if available_ids else 'None'}\n\n"
                f"Create a profile first using create_agent_profile tool."
            )
        
        natal_profile = chart_factory.create_chart(profile.birth_date, profile.birth_place)
        req = EmotionRequest(
            subject_id=agent_id,
            timestamp=datetime.now().astimezone(),
            natal_profile=natal_profile,
            context_hints={"prompt": context_prompt}
        )
        resp = engine.compute_emotion_state(req)
        
        active_emotions = {k: v for k, v in resp.emotion_vector.items() if abs(v - 0.5) > 0.1}
        output = [
            "### Astro-Emotional State",
            f"**Calculated for**: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
            "",
            f"**System Instruction**: {resp.prompt_injection.system_fragment}",
            f"**Style Guideline**: {resp.prompt_injection.style_fragment}",
            "",
            "**Emotional Vector** (0.0-1.0):"
        ]
        for k, v in resp.emotion_vector.items():
            output.append(f"- {k}: {v:.2f}")
            
        output.append("")
        output.append("**Key Influences**:")
        top_influences = sorted(resp.influences, key=lambda x: x.strength, reverse=True)[:3]
        for inf in top_influences:
            output.append(f"- {inf.description} (Strength: {inf.strength:.1f})")
            
        return "\n".join(output)
        
    except Exception as e:
        import traceback
        traceback.print_exc() 
        return f"Error calculating state: {str(e)}"

@mcp.tool()
def get_ad_hoc_emotional_state(birth_date: str, birth_place: str, context_prompt: str = "") -> str:
    """
    Calculates the astrological emotional state for a one-off chart (e.g., for the user).
    
    Args:
        birth_date: ISO 8601 string (e.g. "1990-01-01T12:00:00")
        birth_place: City name (e.g. "London", "New York")
        context_prompt: Optional context (e.g. "User is asking about career")
        
    Returns:
        Formatted string containing System Instructions, Style Guide, and Emotional Vector.
    """
    try:
        natal_profile = chart_factory.create_chart(birth_date, birth_place)
        req = EmotionRequest(
            subject_id="direct_calculation",
            timestamp=datetime.now().astimezone(),
            natal_profile=natal_profile,
            context_hints={"prompt": context_prompt}
        )
        resp = engine.compute_emotion_state(req)
        
        active_emotions = {k: v for k, v in resp.emotion_vector.items() if abs(v - 0.5) > 0.1}
        output = [
            "### Astro-Emotional State",
            f"**Calculated for**: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
            "",
            f"**System Instruction**: {resp.prompt_injection.system_fragment}",
            f"**Style Guideline**: {resp.prompt_injection.style_fragment}",
            "",
            "**Emotional Vector** (0.0-1.0):"
        ]
        for k, v in resp.emotion_vector.items():
            output.append(f"- {k}: {v:.2f}")
            
        output.append("")
        output.append("**Key Influences**:")
        top_influences = sorted(resp.influences, key=lambda x: x.strength, reverse=True)[:3]
        for inf in top_influences:
            output.append(f"- {inf.description} (Strength: {inf.strength:.1f})")
            
        return "\n".join(output)
        
    except Exception as e:
        import traceback
        traceback.print_exc() 
        return f"Error calculating state: {str(e)}"

@mcp.tool()
def get_raw_agent_emotional_state(agent_id: str) -> str:
    """
    Returns the raw emotional JSON data for a registered agent profile.
    
    Args:
        agent_id: Agent profile ID
        
    Returns:
        JSON string of the full emotion state response.
    """
    try:
        profile = profile_manager.get_profile(agent_id)
        if not profile:
            return json.dumps({"error": f"Profile {agent_id} not found"})
            
        natal_profile = chart_factory.create_chart(profile.birth_date, profile.birth_place)
        req = EmotionRequest(
            subject_id=agent_id,
            timestamp=datetime.now().astimezone(),
            natal_profile=natal_profile,
            context_hints={}
        )
        resp = engine.compute_emotion_state(req)
        
        return json.dumps({
            "subject_id": resp.subject_id,
            "emotional_vector": resp.emotion_vector,
            "mood_label": resp.mood_label,
            "influences": [{"desc": i.description, "strength": i.strength} for i in resp.influences]
        })
    except Exception as e:
        return json.dumps({"error": str(e)})

@mcp.tool()
def get_raw_ad_hoc_emotional_state(birth_date: str, birth_place: str) -> str:
    """
    Returns the raw emotional JSON data for a one-off chart calculation.
    
    Args:
        birth_date: ISO 8601 string
        birth_place: City name
        
    Returns:
        JSON string of the full emotion state response.
    """
    try:
        natal_profile = chart_factory.create_chart(birth_date, birth_place)
        req = EmotionRequest(
            subject_id="direct_calculation",
            timestamp=datetime.now().astimezone(),
            natal_profile=natal_profile,
            context_hints={}
        )
        resp = engine.compute_emotion_state(req)
        
        return json.dumps({
            "subject_id": resp.subject_id,
            "emotional_vector": resp.emotion_vector,
            "mood_label": resp.mood_label,
            "influences": [{"desc": i.description, "strength": i.strength} for i in resp.influences]
        })
    except Exception as e:
        return json.dumps({"error": str(e)})

@mcp.tool()
def create_agent_profile(
    agent_id: str,
    name: str,
    birth_date: str,
    birth_place: str
) -> str:
    """
    Create a persistent agent profile with astrological birth data.
    
    Args:
        agent_id: Unique identifier (lowercase, alphanumeric, hyphens/underscores)
        name: Display name for the agent
        birth_date: ISO 8601 birth date (e.g. "1990-01-01T12:00:00")
        birth_place: Birth city name (e.g. "London", "New York")
        
    Returns:
        Success message with profile details
    """
    try:
        profile = profile_manager.create_profile(
            agent_id=agent_id,
            name=name,
            birth_date=birth_date,
            birth_place=birth_place
        )
        return (
            f"✅ Agent profile created successfully!\n\n"
            f"**ID**: {profile.agent_id}\n"
            f"**Name**: {profile.name}\n"
            f"**Birth Date**: {profile.birth_date}\n"
            f"**Birth Place**: {profile.birth_place}\n\n"
            f"Use get_emotional_state(agent_id='{profile.agent_id}') to query this agent's emotional state."
        )
    except Exception as e:
        return f"❌ Error creating profile: {str(e)}"


@mcp.tool()
def list_agent_profiles() -> str:
    """
    List all registered agent profiles.
    
    Returns:
        Formatted list of all agent profiles with their basic info
    """
    try:
        profiles = profile_manager.list_profiles()
        
        if not profiles:
            return (
                "No agent profiles found.\n\n"
                "Create one using create_agent_profile tool."
            )
        
        output = [f"**{len(profiles)} Agent Profile(s)**\n"]
        for p in profiles:
            output.append(f"• **{p.name}** (ID: `{p.agent_id}`)")  
            output.append(f"  Born: {p.birth_date} in {p.birth_place}")
            output.append("")
        
        return "\n".join(output)
    except Exception as e:
        return f"❌ Error listing profiles: {str(e)}"


@mcp.tool()
def get_agent_profile(agent_id: str) -> str:
    """
    Retrieve detailed information about a specific agent profile.
    
    Args:
        agent_id: Agent identifier
        
    Returns:
        Detailed profile information
    """
    try:
        profile = profile_manager.get_profile(agent_id)
        
        if not profile:
            return f"❌ Agent profile '{agent_id}' not found."
        
        return (
            f"**Agent Profile: {profile.name}**\n\n"
            f"**ID**: {profile.agent_id}\n"
            f"**Name**: {profile.name}\n"
            f"**Birth Date**: {profile.birth_date}\n"
            f"**Birth Place**: {profile.birth_place}\n"
            f"**Created**: {profile.created_at}\n"
            f"**Last Updated**: {profile.updated_at}"
        )
    except Exception as e:
        return f"❌ Error retrieving profile: {str(e)}"


@mcp.tool()
def update_agent_profile(
    agent_id: str,
    name: str = "",
    birth_date: str = "",
    birth_place: str = ""
) -> str:
    """
    Update an existing agent profile.
    
    Args:
        agent_id: Agent identifier
        name: New display name (optional)
        birth_date: New birth date (optional)
        birth_place: New birth place (optional)
        
    Returns:
        Success message with updated profile details
    """
    try:
        # Build update kwargs
        updates = {}
        if name:
            updates['name'] = name
        if birth_date:
            updates['birth_date'] = birth_date
        if birth_place:
            updates['birth_place'] = birth_place
        
        if not updates:
            return "❌ No updates provided. Specify at least one field to update."
        
        profile = profile_manager.update_profile(agent_id, **updates)
        
        return (
            f"✅ Profile updated successfully!\n\n"
            f"**ID**: {profile.agent_id}\n"
            f"**Name**: {profile.name}\n"
            f"**Birth Date**: {profile.birth_date}\n"
            f"**Birth Place**: {profile.birth_place}"
        )
    except Exception as e:
        return f"❌ Error updating profile: {str(e)}"


@mcp.tool()
def delete_agent_profile(agent_id: str) -> str:
    """
    Delete an agent profile permanently.
    
    Args:
        agent_id: Agent identifier
        
    Returns:
        Success or error message
    """
    try:
        success = profile_manager.delete_profile(agent_id)
        
        if success:
            return f"✅ Agent profile '{agent_id}' deleted successfully."
        else:
            return f"❌ Agent profile '{agent_id}' not found."
    except Exception as e:
        return f"❌ Error deleting profile: {str(e)}"


@mcp.resource("astro://current_state")
def get_current_state() -> str:
    """Returns the current emotional state for a default profile (World Transit)."""
    # Simply run calculation for 0,0 2000-01-01 (Generic Chart) vs Now
    # For MVP just return a static string or simplified call
    return "Current global transit state implementation pending."

if __name__ == "__main__":
    mcp.run(transport='stdio')
