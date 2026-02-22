# astro_emotion_engine/modules/ — Planetary Influence Modules

Each module calculates the emotional influence of a specific planet or astrological element. They all follow the same interface: accept chart data, return a scored influence dictionary.

---

## Files

| File | Size | Description |
|---|---|---|
| `natal_baseline.py` | 8 KB | **Natal Baseline.** Calculates base personality traits from the natal Sun, Moon, and Ascendant signs. Provides the foundation emotional vector that transits modify. |
| `natal_aspects.py` | 8 KB | **Natal Aspects.** Analyzes angular relationships (conjunction, trine, square, opposition) between natal planets. Adds permanent personality modifiers. |
| `transit_volatility.py` | 7 KB | **Transit Volatility.** Measures how much current planetary positions destabilize the natal chart. Higher volatility = more emotional intensity. |
| `venus.py` | 5 KB | **Venus Module.** Calculates Venus transit influences — affects warmth, sociability, aesthetic sensitivity, and relationship energy. |
| `outer_planets.py` | 5 KB | **Outer Planets.** Uranus, Neptune, and Pluto influences — transformation, intuition, rebellion, and deep psychological shifts. |
| `jupiter.py` | 5 KB | **Jupiter Module.** Expansion, optimism, generosity, and overconfidence influences. |
| `mercury.py` | 4 KB | **Mercury Module.** Communication clarity, analytical thinking, restlessness, and mental agility. |
| `transit_aspects.py` | 4 KB | **Transit Aspects.** Real-time aspects between transiting planets and natal positions. The most dynamic influence layer. |
| `mars.py` | 4 KB | **Mars Module.** Drive, assertiveness, impatience, and physical energy. |
| `saturn.py` | 3 KB | **Saturn Module.** Discipline, restriction, endurance, and melancholy. |
| `moon_phase.py` | 3 KB | **Moon Phase.** Current lunar phase influences — emotional tides, intuition peaks, and reflection periods. |
| `base.py` | 739 B | **Base Class.** Abstract base for all modules — defines the `calculate(chart_data)` interface. |
| `__init__.py` | — | Package initializer. |
