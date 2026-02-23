# TALA Strategic Roadmap (2026-2027)
**Status**: Initialized | **Current Version**: 1.0.0

This document outlines the evolutionary path of Tala from an Autonomous Assistant to a Strategic Agentic System.

---

## 🥇 Priority 1: World Model + Goal Graph
**Status**: [IN PROGRESS]
- **Purpose**: Moves Tala from "turn-by-turn" reactive thinking to long-term proactive task management.
- **Key Components**: 
  - `GoalManager`: Persistent hierarchical task tracking.
  - `WorldEngine` (MCP): Graph of project dependencies (AST analysis).
  - Planning Loop: Internal reasoning turn focusing on goal refinement.

## 🥈 Priority 2: Strategic Planning Layer
**Status**: [PENDING]
- **Purpose**: Evaluate multiple implementation paths and select the optimal route based on cost/risk.
- **Key Components**:
  - Strategy Simulation (Monte Carlo style path weighting).
  - Efficiency Scorecard (Token cost vs Code quality).

## 🥉 Priority 3: Agent Hierarchy + Delegation
**Status**: [PENDING]
- **Purpose**: Parallelize heavy workloads using specialized sub-agents (Minions).
- **Key Components**:
  - Agent Registry and Protocol for "Boss/Minion" communication.
  - Context Slicing to prevent token bloat in sub-agents.

## 🏅 Priority 4: Deep Astro Integration
**Status**: [PENDING]
- **Purpose**: Use emotional/astrological state as a prioritization and risk-bias filter.
- **Key Components**:
  - AstroModulator: Tuning Risk Engine thresholds based on planetary mood.
  - Personality Persistence: Developing "Emotional Debt" and "Bias" across turns.

## 🎖 Priority 5: Economic and Resource Intelligence
**Status**: [PENDING]
- **Purpose**: Autonomous model selection based on per-token cost and task complexity.
- **Key Components**:
  - SmartRouting: Choosing between Local (Ollama) and Cloud models based on ROI.
  - Real-time Spend Dashboard.

## 🎯 Priority 6: Security Hardening
**Status**: [PENDING]
- **Purpose**: Protect sensitive user data and prevent command hijacking.
- **Key Components**:
  - Secret Masking: Post-processing to scrub API keys from logs/outputs.
  - Terminal Whitelisting: Restricting shell access to safe command subsets.

---

## Success Invariants
1. **Safety First**: No strategic autonomous action shall bypass the Risk Engine or Change Budget.
2. **Auditability**: Every goal, strategy, and delegation must be logged in the Artifact Store.
3. **Local-First**: Strategy and Goal Tracking should remain local to the user's workspace for privacy.
