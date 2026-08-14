# Refactoring & De-Cluttering Plan for Golf Stats Dashboard

## Objective
Streamline the Overall dashboard view to eliminate visual clutter, improve scroll hierarchy, fix raw data formatting bugs, and optimize layout containers for CT10 sensor insights.

---

## Priority 1: Formatting Bugs & Quick UI Wins
- [ ] **Fix Floating-Point Number Precision:**
  - Truncate long floating-point strings to 1 decimal place across all metric cards.
  - *Target locations:* 
    - Scrambling Worst: `16.666666666666664` $\rightarrow$ `16.7%`
    - Handicap Diff Best: `18.74146341463415` $\rightarrow$ `18.7`
    - Driving Distance Best/Worst strings in summary footers.
- [ ] **Top Metric Header Strip:**
  - Consolidate the 7 top metric cards into a tighter 2-tier header.
  - *Tier 1 (Primary KPIs):* `Avg Score` (99.9), `Handicap Idx` (21), `Total SG` (-12.4), `GIR %` (3.8%).
  - *Tier 2 (Secondary Sub-header):* Combine `100 Rounds`, `11 Courses`, `37.7 Avg Putts`, and `49.6% Fairway` into a clean single-line metadata bar directly under the header tabs.

---

## Priority 2: Refactoring Trends & Charts (Scroll Depth Reduction)
- [ ] **Consolidate Line Charts into a Tabbed Container:**
  - Replace the long vertical stack of individual trend charts (*Score, Putts, GIR %, Fairways %, Scrambling %, Penalties, Handicap Diff*) with a single **"Trends" Card Container**.
  - Add pill/tab selectors at the top of the container: `[ Score ]` `[ Putts ]` `[ GIR% ]` `[ Fairways ]` `[ Scrambling ]` `[ Penalties ]` `[ Handicap Diff ]`.
  - Default view should load `Score`. Selecting a pill swaps the chart series within the same container.
- [ ] **Standardize Chart Aspect Ratios:**
  - Ensure all trend chart viewports share a consistent fixed height (e.g., `320px`) to prevent page jump when switching tabs.

---

## Priority 3: Enhancing CT10 Sensor Data & Metrics
- [ ] **Approach Distance Bucket Integration (Focus on -10.8 SG Approach Leak):**
  - Add an **Approach Proximity / GIR Zone** breakdown chart or table under the Approach SG category.
  - Group shots by distance zones: `<100 yds`, `100–150 yds`, `150–200 yds`, `>200 yds`.
  - Display **Avg Distance to Pin (ft)** or **GIR % per Zone** calculated from CT10 GPS start-to-end distances.
- [ ] **Filter Distance Box Plots for Outliers:**
  - Update the backend SQL/DataFrame query for *Distance Distribution by Club*:
    - Exclude shots tagged as recovery/punch or trim the lowest 10–15% of distances for full-swing clubs to ensure box plots represent true full shot distances rather than recovery advances.
- [ ] **Putting & Short Game Refinement:**
  - Adjust putting metrics to account for non-sensored putters (manual total putt entry):
    - Highlight **3-Putt Avoidance Rate** (18.4%) prominently as a target metric.
    - Calculate **Putts per GIR** vs. **Putts per Missed Green** to isolate chipping proximity from lag putting performance.

---

## Priority 4: Layout & Grid Re-alignment
- [ ] **Side-by-Side Card Pairing:**
  - Pair *Scoring Summary* and *Putting Summary* into a 2-column grid row.
  - Pair *Club Distance Distribution* and *Club Usage Frequency* into a side-by-side or tabbed module to reduce vertical height.
- [ ] **Move Course Breakdown:**
  - Ensure the *Course Comparison Table* stays anchored at the bottom as a dedicated drill-down section, keeping summary visual charts above the fold.