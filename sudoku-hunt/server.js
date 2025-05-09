const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000; // Use environment port for production

// Enhanced middleware setup
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Fix for static files in production
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store');
    }
  }
}));

// Production-compatible session configuration
app.use(session({
    secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production' ? true : false,
    httpOnly: true,
    sameSite: 'lax', // Important for production
    maxAge: 24 * 60 * 60 * 1000
  },
  // Simple file-based session store for production
  store: new (require('session-file-store')(session))({
    path: path.join(__dirname, 'sessions')
  })
}));

// Data file paths - ensure they work in production
const DATA_DIR = path.join(__dirname, 'data');
const CODES_PATH = path.join(DATA_DIR, 'codes.json');
const TEAMS_PATH = path.join(DATA_DIR, 'teams.json');
// Add near other constants at the top
const CODES_ROUND3_PATH = path.join(DATA_DIR, 'codes_round3.json');

// Add to file initialization
if (!fs.existsSync(CODES_ROUND3_PATH)) {
    fs.writeFileSync(CODES_ROUND3_PATH, '{}', 'utf8');
}

// Initialize data directory and files with error handling
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize session directory
if (!fs.existsSync(path.join(__dirname, 'sessions'))) {
    fs.mkdirSync(path.join(__dirname, 'sessions'), { recursive: true });
}

[CODES_PATH, TEAMS_PATH].forEach(file => {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, file === TEAMS_PATH ? '{}' : '[]', 'utf8');
    }
});

// Enhanced team data structure
const DEFAULT_TEAM = {
    password: '',
    points: 0,
    currentClue: null,
    attempts: {},
    disqualified: false
};

// Improved data loading middleware
app.use((req, res, next) => {
    try {
        // Read and parse files safely
        const codesData = fs.readFileSync(CODES_PATH, 'utf-8');
        const teamsData = fs.readFileSync(TEAMS_PATH, 'utf-8');
        const round3CodesData = fs.readFileSync(CODES_ROUND3_PATH, 'utf-8');
        
        req.codes = codesData ? JSON.parse(codesData) : [];
        req.teams = teamsData ? JSON.parse(teamsData) : {};
        req.round3Codes = round3CodesData ? JSON.parse(round3CodesData) : {};
        
        next();
    } catch (err) {
        console.error('Error loading data:', err);
        // Initialize with empty data if there's an error
        req.codes = [];
        req.teams = {};
        next(err);
    }
});

// Save functions
function saveCodes(codes) {
    try {
        fs.writeFileSync(CODES_PATH, JSON.stringify(codes, null, 2));
        return true;
    } catch (err) {
        console.error('Error saving codes:', err);
        return false;
    }
}

function saveTeams(teams) {
    try {
        fs.writeFileSync(TEAMS_PATH, JSON.stringify(teams, null, 2));
        return true;
    } catch (err) {
        console.error('Error saving teams:', err);
        return false;
    }
}

// Auth middleware
function checkAuth(req, res, next) {
    if (req.session.team || req.path.includes('/login')) {
        return next();
    }
    res.redirect('/index.html?message=Session+expired.+Please+login+again.&messageType=error');
}

// Login route
app.post('/login', (req, res) => {
    const { teamName, password } = req.body;
    
    // Input validation
    if (!teamName || !password) {
        return res.redirect('/index.html?message=Team+name+and+password+required&messageType=error');
    }

    // Team existence and password check
    if (!req.teams[teamName] || req.teams[teamName].password !== password) {
        return res.redirect('/index.html?message=Invalid+credentials.+Please+try+again.&messageType=error');
    }

    // Set session
    req.session.team = teamName;
    req.session.save(err => {
        if (err) {
            console.error('Session save error:', err);
            return res.redirect('/index.html?message=Login+failed&messageType=error');
        }

        // Admin redirection
        if (teamName.toLowerCase() === 'admin') {
            return res.redirect('/admin.html');
        }

        const team = req.teams[teamName];

        // Check disqualification
        if (team.disqualified) {
            const message = team.points >= 100 
                ? 'Your+team+did+not+qualify+for+Round+3' 
                : 'Your+team+has+been+disqualified';
            return res.redirect(`/dashboard.html?team=${encodeURIComponent(teamName)}&message=${message}&messageType=error`);
        }

        // Determine current round (default to round2 if not set)
        const currentRound = req.session.currentRound || 'round2';

        // Round 3 qualification check
        if (currentRound === 'round3') {
            if (team.points >= 100) {
                // Initialize Round 3 data if it doesn't exist
                if (!team.round3) {
                    team.round3 = {
                        completedChallenges: [],
                        currentChallenge: null,
                        score: team.points,
                        availableChallenges: ['challenge1', 'challenge2', 'challenge3']
                    };
                    saveTeams(req.teams);
                }
                return res.redirect(`/rules_round3.html?team=${encodeURIComponent(teamName)}`);
            } else {
                // Team didn't qualify for Round 3
                team.disqualified = true;
                saveTeams(req.teams);
                return res.redirect(`/dashboard.html?team=${encodeURIComponent(teamName)}&message=Your+team+did+not+qualify+for+Round+3&messageType=error`);
            }
        }

        // Round 2 initialization
        if (!team.round2) {
            team.round2 = {
                availableCodes: Array.from({length: 10}, (_, i) => `code${i+1}`),
                frozenCodes: [],
                attempts: {},
                completedCodes: []
            };
            saveTeams(req.teams);
        }

        // Default to Round 2
        return res.redirect(`/rules_round2.html?team=${encodeURIComponent(teamName)}`);
    });
});

// Protected routes
app.get('/dashboard.html', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

app.get('/admin.html', checkAuth, (req, res) => {
    if (req.session.team?.toLowerCase() !== 'admin') {
        return res.redirect('/index.html');
    }
    res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// Rules page route
app.get('/rules_round2.html', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public/rules_round2.html'));
});

// Round 2 code selection page
app.get('/round2.html', checkAuth, (req, res) => {
    const team = req.session.team;
    const teamData = req.teams[team];
    
    if (!teamData.round2) {
        teamData.round2 = {
            availableCodes: Array.from({length: 10}, (_, i) => `code${i+1}`),
            frozenCodes: [],
            attempts: {}
        };
        saveTeams(req.teams);
    }
    
    res.sendFile(path.join(__dirname, 'public/round2.html'));
});

// Handle code selection
app.post('/select-code', (req, res) => {
    const { team, code } = req.body;

    if (!team || !code) {
        return res.status(400).json({ 
            success: false,
            error: "Team name and code are required",
            redirect: `/round2.html?message=Team+name+and+code+required&messageType=error`
        });
    }

    if (!req.teams[team]) {
        return res.status(400).json({ 
            success: false,
            error: "Team not found",
            redirect: `/round2.html?team=${team}&message=Team+not+found&messageType=error`
        });
    }

    const teamData = req.teams[team];
    
    if (!teamData.round2) {
        teamData.round2 = {
            availableCodes: Array.from({length: 10}, (_, i) => `code${i+1}`),
            frozenCodes: [],
            attempts: {}
        };
    }

    if (!teamData.round2.availableCodes.includes(code)) {
        return res.status(400).json({ 
            success: false,
            error: "Code not available",
            redirect: `/round2.html?team=${team}&message=Code+not+available&messageType=error`
        });
    }

    req.session.selectedCode = code;
    req.session.save(err => {
        if (err) {
            console.error('Session save error:', err);
            return res.status(500).json({ 
                success: false,
                error: "Session error",
                redirect: `/round2.html?team=${team}&message=Session+error&messageType=error`
            });
        }

        res.json({ 
            success: true,
            redirect: `/dashboard.html?team=${team}&code=${code}`
        });
    });
});

// Submit code endpoint - Fixed the foundClue issue
app.post('/submit-code', (req, res) => {
    const { team, selectedCode, clueNumber } = req.body;
    const teams = JSON.parse(fs.readFileSync(TEAMS_PATH));
    const codes = JSON.parse(fs.readFileSync(CODES_PATH));
    
    const teamData = teams[team];
    const codeData = codes[selectedCode]; // Directly access the code object

    // Validate team exists
    if (!teamData) {
        return res.status(400).json({ 
            error: "Invalid team",
            redirect: `/round2.html?team=${team}&message=Invalid+team&messageType=error`
        });
    }

    // Validate code exists
    if (!codeData) {
        return res.status(400).json({ 
            error: "Invalid code selected",
            redirect: `/round2.html?team=${team}&message=Invalid+code+selected&messageType=error`
        });
    }

    // Track attempts
    teamData.round2.attempts[selectedCode] = (teamData.round2.attempts[selectedCode] || 0) + 1;
    const attemptsLeft = 3 - teamData.round2.attempts[selectedCode];

    // Check if clue number matches
    if (clueNumber !== codeData.clueNumber) {
        // Freeze if no attempts left
        if (attemptsLeft <= 0) {
            teamData.round2.availableCodes = teamData.round2.availableCodes.filter(c => c !== selectedCode);
            teamData.round2.frozenCodes.push(selectedCode);
        }
        
        fs.writeFileSync(TEAMS_PATH, JSON.stringify(teams, null, 2));
        
        return res.status(400).json({
            error: "Invalid clue number",
            message: attemptsLeft > 0 ? `${attemptsLeft} attempts remaining` : "Code locked!",
            redirect: attemptsLeft <= 0 ? 
                `/round2.html?team=${team}&message=Code+locked&messageType=error` : 
                `/dashboard.html?team=${team}&code=${selectedCode}&message=Invalid+clue+${attemptsLeft}+attempts+left&messageType=error`
        });
    }

    // Success - update team data
    teamData.currentClue = selectedCode;
    teamData.round2.availableCodes = teamData.round2.availableCodes.filter(c => c !== selectedCode);
    fs.writeFileSync(TEAMS_PATH, JSON.stringify(teams, null, 2));

    // Redirect to map with coordinates
    res.json({
        success: true,
        redirect: `/map.html?lat=${codeData.location.lat}&lng=${codeData.location.lng}&team=${team}&code=${selectedCode}`
    });
});
// Verify clue at location
app.post('/verify-clue', (req, res) => {
    const { team, clueCode, enteredCode } = req.body;
    
    console.log(`Verify attempt: Team=${team}, Clue=${clueCode}, Code=${enteredCode}`);

    // Validate team
    if (!team || !req.teams[team]) {
        console.error('Invalid team:', team);
        return res.status(400).json({ success: false, message: "Invalid team." });
    }

    // Find the clue
    const codeIndex = req.codes.findIndex(c => c.code === clueCode);
    if (codeIndex === -1) {
        console.error('Clue not found:', clueCode);
        return res.status(400).json({ success: false, message: "Invalid clue code." });
    }
    const codeData = req.codes[codeIndex];

    // Check verification code
    if (enteredCode !== codeData.verificationCode) {
        console.log('Incorrect verification code');
        return res.status(200).json({ 
            success: false, 
            message: "Incorrect code. Please try again." 
        });
    }

    // Initialize completedBy if doesn't exist
    if (!Array.isArray(codeData.completedBy)) {
        codeData.completedBy = [];
    }

    // Initialize teams if doesn't exist
    if (!Array.isArray(codeData.teams)) {
        codeData.teams = [];
    }

    // Only proceed if team hasn't completed this before
    if (!codeData.completedBy.includes(team)) {
        console.log(`Recording completion for team ${team}`);
        codeData.completedBy.push(team);

        // Add team to teams[] if not already there
        if (!codeData.teams.includes(team)) {
            codeData.teams.push(team);
        }

        // Award points if first completion
        if (codeData.completedBy.length === 1) {
            req.teams[team].points += 100;
            codeData.locked = true;
            console.log(`Awarded 100 points to ${team} for first completion`);
        }
        
        // Clear current clue now that it's completed
        req.teams[team].currentClue = null;
        
        // Save changes
        if (!saveTeams(req.teams) || !saveCodes(req.codes)) {
            console.error('Failed to save data');
            return res.status(500).json({ success: false, message: "Error saving progress" });
        }
        
        console.log('Updated clue:', codeData);
    }

    res.status(200).json({
        success: true,
        points: req.teams[team].points,
        message: codeData.completedBy.length === 1 
            ? "✅ Bomb defused! 100 points awarded!" 
            : "Clue verified!"
    });
});
app.get('/current-round', (req, res) => {
    try {
        res.json({
            currentRound: req.session.currentRound || 'round2'
        });
    } catch (error) {
        console.error('Error getting current round:', error);
        res.status(500).json({ error: 'Failed to get current round' });
    }
});
// Round 3 code verification
app.post('/verify-round3-clue', (req, res) => {
    const { team, code, clueNumber } = req.body;
    const teams = JSON.parse(fs.readFileSync(TEAMS_PATH));
    const round3Codes = JSON.parse(fs.readFileSync(CODES_ROUND3_PATH));
    
    const teamData = teams[team];
    const codeData = round3Codes[code];

    // Validate team exists and is qualified
    if (!teamData || !teamData.round3) {
        return res.status(400).json({ 
            error: "Team not qualified for Round 3",
            redirect: `/index.html?message=Not+qualified+for+Round+3&messageType=error`
        });
    }

    // Validate code exists
    if (!codeData) {
        return res.status(400).json({ 
            error: "Invalid code selected",
            redirect: `/round3.html?team=${team}&message=Invalid+code&messageType=error`
        });
    }

    // Check clue number matches
    if (clueNumber !== codeData.clueNumber) {
        return res.status(400).json({
            error: "Invalid clue number", 
            redirect: `/round3.html?team=${team}&message=Invalid+clue+number&messageType=error`
        });
    }

    // Success - redirect to map
    res.json({
        success: true,
        redirect: `/map1.html?team=${team}&code=${code}&lat=${codeData.location.lat}&lng=${codeData.location.lng}`
    });
});

// Final verification at location
app.post('/verify-round3-final', (req, res) => {
    const { team, code, verificationCode } = req.body;
    const teams = JSON.parse(fs.readFileSync(TEAMS_PATH));
    const round3Codes = JSON.parse(fs.readFileSync(CODES_ROUND3_PATH));
    
    const teamData = teams[team];
    const codeData = round3Codes[code];

    // Validate verification code
    if (verificationCode !== codeData.verificationCode) {
        return res.status(400).json({
            error: "Invalid final code",
            redirect: `/map1.html?team=${team}&code=${code}&message=Invalid+final+code&messageType=error`
        });
    }

    // Mark as winner and end game
    teamData.winner = true;
    saveTeams(teams);

    // Notify all players
    Object.keys(teams).forEach(t => {
        if (t !== team) {
            teams[t].gameOver = true;
        }
    });
    saveTeams(teams);

    res.json({
        success: true,
        message: "Congratulations! You defused the bomb!",
        redirect: `/winner.html?team=${team}`
    });
});

// Update switch-round to initialize Round 3 properly
app.post('/switch-round', async (req, res) => {
    try {
        const { targetRound } = req.body;
        
        if (!['round2', 'round3'].includes(targetRound)) {
            return res.status(400).json({ error: 'Invalid round specified' });
        }

        const teams = JSON.parse(await fs.promises.readFile(TEAMS_PATH, 'utf-8')) || {};
        let qualifiedTeams = 0;
        
        if (targetRound === 'round3') {
            qualifiedTeams = Object.keys(teams).filter(teamName => {
                const team = teams[teamName];
                return team.points >= 100 && !team.disqualified;
            }).length;
            
            if (qualifiedTeams === 0) {
                return res.status(400).json({ 
                    error: 'No teams qualified for Round 3 (need 100+ points)' 
                });
            }
            
            Object.keys(teams).forEach(teamName => {
                const team = teams[teamName];
                
                if (team.points >= 100 && !team.disqualified) {
                    team.round3 = {
                        availableCodes: Array.from({length: 10}, (_, i) => `code${i+1}`),
                        frozenCodes: [],
                        attempts: {},
                        completedCodes: []
                    };
                } else {
                    team.disqualified = true;
                }
            });
        } else {
            // Switching back to round2
            Object.keys(teams).forEach(teamName => {
                teams[teamName].disqualified = false;
            });
        }
        
        req.session.currentRound = targetRound;
        await fs.promises.writeFile(TEAMS_PATH, JSON.stringify(teams, null, 2));
        
        res.json({
            success: true,
            currentRound: targetRound,
            qualifiedTeams
        });
        
    } catch (error) {
        console.error('Error switching rounds:', error);
        res.status(500).json({ 
            error: 'Failed to switch rounds',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Add game status check
app.get('/game-status', (req, res) => {
    const teams = JSON.parse(fs.readFileSync(TEAMS_PATH));
    const gameOver = Object.values(teams).some(team => team.gameOver);
    res.json({ gameOver });
});
// Round 3 rules page
app.get('/rules_round3.html', checkAuth, (req, res) => {
    const team = req.session.team;
    if (!team || req.teams[team]?.points < 100) {
        return res.redirect('/index.html?message=Not+qualified+for+Round+3');
    }
    res.sendFile(path.join(__dirname, 'public/rules_round3.html'));
});

// Round 3 dashboard
app.get('/round3.html', checkAuth, (req, res) => {
    const team = req.session.team;
    if (!team || req.teams[team]?.points < 100) {
        return res.redirect('/index.html?message=Not+qualified+for+Round+3');
    }
    res.sendFile(path.join(__dirname, 'public/round3.html'));
});

// Round 3 map
app.get('/map1.html', checkAuth, (req, res) => {
    const team = req.session.team;
    if (!team || req.teams[team]?.points < 100) {
        return res.redirect('/index.html?message=Not+qualified+for+Round+3');
    }
    res.sendFile(path.join(__dirname, 'public/map1.html'));
});

// Get winner
app.get('/get-winner', (req, res) => {
    try {
        const teams = JSON.parse(fs.readFileSync(TEAMS_PATH, 'utf-8')) || {};
        
        // Find team with highest points that isn't disqualified
        let winner = null;
        let maxPoints = 0;
        
        Object.keys(teams).forEach(teamName => {
            const team = teams[teamName];
            if (!team.disqualified && team.points > maxPoints) {
                maxPoints = team.points;
                winner = teamName;
            }
        });
        
        res.json({ winner });
        
    } catch (error) {
        console.error('Error getting winner:', error);
        res.status(500).json({ error: 'Failed to determine winner' });
    }
});
app.get('/admin-data', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync('data.json'));
        res.json(data);
    } catch (error) {
        console.error('Error reading data.json:', error);
        res.status(500).json({ error: 'Failed to load data' });
    }
});

// Admin endpoints
app.get('/admin-teams', (req, res) => {
    try {
        const teams = JSON.parse(fs.readFileSync(TEAMS_PATH, 'utf-8')) || {};
        res.json(teams);
    } catch (error) {
        console.error('Error loading teams:', error);
        res.status(500).json({ error: 'Failed to load team data' });
    }
});

// Admin clues data
app.get('/admin-clues', (req, res) => {
    try {
        const codes = JSON.parse(fs.readFileSync(CODES_PATH, 'utf-8')) || [];
        res.json(codes);
    } catch (error) {
        console.error('Error loading clues:', error);
        res.status(500).json({ error: 'Failed to load clue data' });
    }
});

app.get('/debug-clue/:code', (req, res) => {
    const codeData = req.codes.find(c => c.code === req.params.code);
    if (!codeData) {
        return res.status(404).send('Clue not found');
    }
    res.json({
        clue: codeData,
        teams: Object.keys(req.teams).filter(team => 
            req.teams[team].currentClue === req.params.code
        )
    });
});

// Team management
app.post('/create-team', (req, res) => {
    try {
        const { name, password } = req.body;
        
        if (!name || !password) {
            return res.status(400).json({ error: 'Team name and password are required' });
        }
        
        const teams = JSON.parse(fs.readFileSync(TEAMS_PATH, 'utf-8')) || {};
        
        if (teams[name]) {
            return res.status(400).json({ error: 'Team already exists' });
        }
        
        // Create new team with default structure
        teams[name] = {
            password,
            points: 0,
            currentClue: null,
            attempts: {},
            disqualified: false,
            round2: {
                availableCodes: Array.from({length: 10}, (_, i) => `code${i+1}`),
                frozenCodes: [],
                completedCodes: [],
                attempts: {}
            }
        };
        
        fs.writeFileSync(TEAMS_PATH, JSON.stringify(teams, null, 2));
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Error creating team:', error);
        res.status(500).json({ error: 'Failed to create team' });
    }
});

// Reset single team
app.post('/reset-team', (req, res) => {
    try {
        const { team } = req.body;
        
        const teams = JSON.parse(fs.readFileSync(TEAMS_PATH, 'utf-8')) || {};
        const codes = JSON.parse(fs.readFileSync(CODES_PATH, 'utf-8')) || [];
        
        if (!teams[team]) {
            return res.status(400).json({ error: 'Team not found' });
        }
        
        // Reset team data
        teams[team] = {
            password: teams[team].password,
            points: 0,
            currentClue: null,
            attempts: {},
            disqualified: false,
            round2: {
                availableCodes: Array.from({length: 10}, (_, i) => `code${i+1}`),
                frozenCodes: [],
                completedCodes: [],
                attempts: {}
            }
        };
        
        // Remove team from any clues they completed
        codes.forEach(clue => {
            if (clue.completedBy?.includes(team)) {
                clue.completedBy = clue.completedBy.filter(t => t !== team);
                if (clue.completedBy.length === 0) {
                    clue.locked = false;
                }
            }
            
            if (clue.teams?.includes(team)) {
                clue.teams = clue.teams.filter(t => t !== team);
            }
        });
        
        fs.writeFileSync(TEAMS_PATH, JSON.stringify(teams, null, 2));
        fs.writeFileSync(CODES_PATH, JSON.stringify(codes, null, 2));
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Error resetting team:', error);
        res.status(500).json({ error: 'Failed to reset team' });
    }
});

// Reset all teams
app.post('/reset-all', (req, res) => {
    try {
        const teams = JSON.parse(fs.readFileSync(TEAMS_PATH, 'utf-8')) || {};
        const codes = JSON.parse(fs.readFileSync(CODES_PATH, 'utf-8')) || [];
        
        // Reset all teams
        Object.keys(teams).forEach(teamName => {
            teams[teamName] = {
                password: teams[teamName].password,
                points: 0,
                currentClue: null,
                attempts: {},
                disqualified: false,
                round2: {
                    availableCodes: Array.from({length: 10}, (_, i) => `code${i+1}`),
                    frozenCodes: [],
                    completedCodes: [],
                    attempts: {}
                }
            };
        });
        
        // Reset all clues
        codes.forEach(clue => {
            clue.completedBy = [];
            clue.teams = [];
            clue.locked = false;
        });
        
        // Reset session
        req.session.currentRound = 'round2';
        
        fs.writeFileSync(TEAMS_PATH, JSON.stringify(teams, null, 2));
        fs.writeFileSync(CODES_PATH, JSON.stringify(codes, null, 2));
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Error resetting all:', error);
        res.status(500).json({ error: 'Failed to reset all data' });
    }
});

// Reset points only
app.post('/reset-points', (req, res) => {
    try {
        const teams = JSON.parse(fs.readFileSync(TEAMS_PATH, 'utf-8')) || {};
        
        // Reset points for all teams
        Object.keys(teams).forEach(teamName => {
            teams[teamName].points = 0;
        });
        
        fs.writeFileSync(TEAMS_PATH, JSON.stringify(teams, null, 2));
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Error resetting points:', error);
        res.status(500).json({ error: 'Failed to reset points' });
    }
});

// Add this endpoint to your server.js (before app.listen)
app.get('/team-data', checkAuth, (req, res) => {
    try {
        const teamName = req.session.team;
        
        if (!teamName) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        // Read fresh data (don't rely on middleware cache)
        const teamsData = fs.readFileSync(TEAMS_PATH, 'utf-8');
        const teams = teamsData ? JSON.parse(teamsData) : {};
        
        if (!teams[teamName]) {
            return res.status(404).json({ 
                error: "Team not found",
                team: teamName 
            });
        }

        // Initialize round2 if missing
        if (!teams[teamName].round2) {
            teams[teamName].round2 = {
                availableCodes: Array.from({length: 10}, (_, i) => `code${i+1}`),
                frozenCodes: [],
                attempts: {}
            };
            fs.writeFileSync(TEAMS_PATH, JSON.stringify(teams, null, 2));
        }

        res.json({
            success: true,
            team: teamName,
            round2: teams[teamName].round2
        });

    } catch (error) {
        console.error('Team data error:', error);
        res.status(500).json({ 
            error: "Server error",
            details: error.message 
        });
    }
});
app.get('/test-session', (req, res) => {
    req.session.test = 'working';
    res.send(`Session test: ${req.session.test}. Secret length: ${process.env.SESSION_SECRET?.length || 0} chars`);
  });

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});