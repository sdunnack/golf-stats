# TrackMan & Simulator Integration Plan

# Objective
Expand the Golf Stats Dashboard by adding a dedicated Simulator / Practice tab. This separates controlled indoor/range metrics (TrackMan) from chaotic on-course performance (Garmin CT10 sensors), while providing clean club gapping, spin optimization, and dispersion analysis.

# 1. Data Architecture & Separation
To keep on-course performance metrics (like your approach game and handicap tracking) clean, introduce a separate data schema for simulator sessions.

## A. Directory & File Structure
Keep raw/processed simulator data in a dedicated folder: data/simulator/.

Example schema (data/simulator/sessions.json):

```JSON
{
  "sessionId": "tm_2026_10_22_01",
  "date": "2026-10-22",
  "sessionType": "range",
  "shots": [
    {
      "club": "Ol' Reliable",
      "ballSpeed": 118.5,
      "launchAngle": 14.2,
      "spinRate": 5200,
      "carryDistance": 152.1,
      "totalDistance": 164.0,
      "sideTotal": -2.4,
      "clubPath": 1.1,
      "faceAngle": -0.5,
      "smashFactor": 1.42
    }
  ]
}
```

## B. Database / State Flagging
Add a source discriminator (garmin vs trackman) to ensure global aggregations don't accidentally ingest range swings.

# 3. Automated Data Pull Script (GitHub Actions)
Since the project runs via a GitHub-hosted static workflow, automation is handled via a custom Node.js script triggered via GitHub Actions.

## A. Authentication & Session Handling
Cookie/Token Capture: TrackMan uses session tokens/cookies for authentication. Capture your bearer token or session cookie from an authenticated browser session and store it securely as a GitHub Secret (TRACKMAN_API_TOKEN).

Endpoint Targeting: Hit TrackMan’s internal player portal endpoints to fetch activity reports.

B. Sync Script Implementation (scripts/sync-trackman.js)

```JavaScript
const fs = require('fs');
const fetch = require('node-fetch');

const TRACKMAN_API_URL = 'https://api.trackmangolf.com/v1/player/activities';
const TOKEN = process.env.TRACKMAN_API_TOKEN;

async function fetchSimulatorSessions() {
  try {
    console.log('Fetching latest TrackMan sessions...');
    const response = await fetch(TRACKMAN_API_URL, {
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    
    const data = await response.json();
    const processedData = transformSessions(data);
    fs.writeFileSync('./data/simulator/sessions.json', JSON.stringify(processedData, null, 2));
    console.log('Successfully updated simulator data!');
  } catch (error) {
    console.error('Failed to sync TrackMan data:', error);
    process.exit(1);
  }
}

function transformSessions(rawApiData) {
  return rawApiData.map(session => ({
    sessionId: session.id,
    date: session.date,
    sessionType: session.type,
    shots: session.shots.map(shot => ({
      club: mapClubName(shot.clubName),
      ballSpeed: shot.ballSpeed,
      carryDistance: shot.carry,
      totalDistance: shot.total,
      sideTotal: shot.sideTotal,
      spinRate: shot.spinRate,
      launchAngle: shot.launchAngle,
      smashFactor: shot.smashFactor,
      clubPath: shot.clubPath
    }))
  }));
}

function mapClubName(tmClub) {
  const mapping = {
    '7-Iron': "Ol' Reliable",
    'Driver': 'Dream Machine',
  };
  return mapping[tmClub] || tmClub;
}

fetchSimulatorSessions();
```

## C. GitHub Actions Workflow (.github/workflows/sync-trackman.yml)
``` YAML
name: Sync TrackMan Data

on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v3

      - name: Set up Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install node-fetch

      - name: Run TrackMan Sync Script
        env:
          TRACKMAN_API_TOKEN: ${{ secrets.TRACKMAN_API_TOKEN }}
        run: node scripts/sync-trackman.js

      - name: Commit and push if changes
        run: |
          git config --global user.name 'github-actions[bot]'
          git config --global user.email 'github-actions[bot]@users.noreply.github.com'
          git add data/simulator/sessions.json
          git diff --quiet && git diff --staged || (git commit -m "Auto-sync TrackMan data" && git push)
```

# 4. Frontend UI: The Simulator Tab & Enhanced Tracking
Add a new Simulator tab to your navigation alongside Stats, Insights, and Training.

## A. Core Data Tracked (TrackMan Exclusive Metrics)
Ball Flight Mechanics: Launch Angle, Spin Rate (Backspin/Sidespin), and Smash Factor.

Club Delivery: Club Path and Face-to-Path angles.

Dispersion Control: Lateral offline distance (sideTotal) mapped across sample sizes per club.

## B. UI Component Ideas
Indoor vs. On-Course Gapping Matrix: A side-by-side or overlaid comparison table showing your TrackMan stock carry distances (pristine/controlled air) against your Garmin on-course distances (where turf interaction, lies, and weather impact results).

Club Dispersion Scatter Plots: Visual scatter charts plotting distance (Y-axis) vs. lateral miss (X-axis) for individual clubs (e.g., checking if "Ol' Reliable" has a consistent push/pull tendency in a climate-controlled setting).

Spin & Launch Optimization Cards: Summary widgets highlighting whether your launch angles and spin rates fall into optimal windows for your swing speed by club category.

Simulator Session Feed: A chronological list of recent range/indoor sessions with quick metrics (Total Shots, Average Ball Speed, Efficiency/Smash Factor, and Session Type).