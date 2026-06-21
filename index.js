document.addEventListener("DOMContentLoaded", () => {
    // DOM Elements
    const terminalScreen = document.getElementById("terminal-screen");
    const cmdInput = document.getElementById("cmd-input");
    const sendCmdBtn = document.getElementById("send-cmd-btn");
    const reconnectBtn = document.getElementById("reconnect-btn");
    const resetAgeVal = document.getElementById("reset-age-val");
    const latencyVal = document.getElementById("latency-val");
    
    const pulseIndicator = document.querySelector(".pulse-indicator");
    
    const statLevel = document.getElementById("stat-level");
    const charNameTitle = document.getElementById("char-name-title");
    const statStamina = document.getElementById("stat-stamina");
    const staminaProgress = document.getElementById("stamina-progress");
    
    // Tell Window DOM
    const tellList = document.getElementById("tell-list");
    const clearTellsBtn = document.getElementById("clear-tells-btn");
    let knownTellsCount = 0;
    

    // Macros DOM
    const macrosGrid = document.getElementById("macros-grid");
    const editMacrosBtn = document.getElementById("edit-macros-btn");
    let isEditingMacros = false;
    
    const onlinePlayersList = document.getElementById("online-players-list");
    const offlinePlayersList = document.getElementById("offline-players-list");
    const countOnline = document.getElementById("count-online");
    const countOffline = document.getElementById("count-offline");
    
    // Snoop elements
    const snoopPanel = document.getElementById("snoop-screen");
    const snoopContent = document.getElementById("snoop-content");
    const snoopResizer = document.getElementById("snoop-resizer");
    const closeSnoopBtn = document.getElementById("close-snoop-btn");
    const snoopTitleText = document.getElementById("snoop-title-text");
    let isSnoopingLine = false;

    // Mobile drawer: move secondary panels out of the play surface on phone screens.
    const mobileMenuToggle = document.getElementById("mobile-menu-toggle");
    const mobileMenuClose = document.getElementById("mobile-menu-close");
    const mobileDrawerBackdrop = document.getElementById("mobile-drawer-backdrop");
    const mobileDrawerContent = document.getElementById("mobile-drawer-content");
    const mobileDrawerMedia = window.matchMedia("(max-width: 760px)");
    const panelHeader = document.querySelector(".panel-header");
    const topCharacterCard = document.querySelector(".top-character-card");
    const sidebarPanel = document.querySelector(".sidebar-panel");
    const mobileDrawerItems = [];
    const mobileMenuPlaceholder = document.createComment("mobile menu placeholder");
    if (mobileMenuToggle && mobileMenuToggle.parentNode) {
        mobileMenuToggle.parentNode.insertBefore(mobileMenuPlaceholder, mobileMenuToggle);
    }

    function trackMobileDrawerItem(node, classNames = "") {
        if (!node || !node.parentNode) return;
        const placeholder = document.createComment("mobile drawer placeholder");
        node.parentNode.insertBefore(placeholder, node);
        mobileDrawerItems.push({ node, placeholder, classNames });
    }

    trackMobileDrawerItem(topCharacterCard);
    trackMobileDrawerItem(panelHeader?.children[1], "mobile-drawer-actions");
    trackMobileDrawerItem(panelHeader?.children[2], "mobile-drawer-actions");
    trackMobileDrawerItem(sidebarPanel);

    function setMobileMenuOpen(open) {
        if (!mobileMenuToggle || !mobileDrawerBackdrop) return;
        document.body.classList.toggle("mobile-menu-open", open);
        mobileDrawerBackdrop.classList.toggle("hidden", !open);
        mobileMenuToggle.setAttribute("aria-expanded", open ? "true" : "false");
    }

    function setSnoopMenuDocked(docked) {
        if (!mobileMenuToggle || !reconnectBtn || !mobileMenuPlaceholder.parentNode) return;
        const shouldDock = docked && mobileDrawerMedia.matches;

        if (shouldDock) {
            reconnectBtn.parentNode.insertBefore(mobileMenuToggle, reconnectBtn);
            mobileMenuToggle.classList.add("snoop-docked");
        } else {
            mobileMenuPlaceholder.parentNode.insertBefore(mobileMenuToggle, mobileMenuPlaceholder.nextSibling);
            mobileMenuToggle.classList.remove("snoop-docked");
        }
    }

    function setMobileDrawerEnabled(enabled) {
        if (!mobileDrawerContent) return;
        document.body.classList.toggle("mobile-terminal-mode", enabled);

        mobileDrawerItems.forEach(({ node, placeholder, classNames }) => {
            if (enabled) {
                if (classNames) {
                    node.classList.add(...classNames.split(" ").filter(Boolean));
                }
                if (node.parentNode !== mobileDrawerContent) {
                    mobileDrawerContent.appendChild(node);
                }
            } else {
                if (node.parentNode !== placeholder.parentNode && placeholder.parentNode) {
                    placeholder.parentNode.insertBefore(node, placeholder.nextSibling);
                }
                if (classNames) {
                    node.classList.remove(...classNames.split(" ").filter(Boolean));
                }
            }
        });

        if (!enabled) {
            setMobileMenuOpen(false);
            setSnoopMenuDocked(false);
        }
    }

    if (mobileMenuToggle && mobileMenuClose && mobileDrawerBackdrop && mobileDrawerContent) {
        mobileMenuToggle.addEventListener("click", () => {
            setMobileMenuOpen(!document.body.classList.contains("mobile-menu-open"));
        });
        mobileMenuClose.addEventListener("click", () => setMobileMenuOpen(false));
        mobileDrawerBackdrop.addEventListener("click", () => setMobileMenuOpen(false));
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                setMobileMenuOpen(false);
            }
        });

        setMobileDrawerEnabled(mobileDrawerMedia.matches);
        if (mobileDrawerMedia.addEventListener) {
            mobileDrawerMedia.addEventListener("change", (event) => setMobileDrawerEnabled(event.matches));
        } else {
            mobileDrawerMedia.addListener((event) => setMobileDrawerEnabled(event.matches));
        }
    }

    // Advanced UI Tracking
    const sleepOverlay = document.getElementById("sleep-overlay");
    const combatHud = document.getElementById("combat-hud");
    const combatLogList = document.getElementById("combat-log-list");

    // State
    
    let commandHistory = [];
    let historyIndex = -1;
    let myName = "";
    let lastSentCommand = "";
    let isSnoopCollapsed = false;
    let activeSnoopTarget = "";
    let loginState = {
        prompt: "",
        pendingUsername: "",
        autoLoginPass: ""
    };
    let cachedKnownPlayers = [];
    const credentialsStorageKey = "mud_credentials";
    const credentialsBuildKey = "mud_credentials_build";

    function getClientBuildId() {
        const script = document.querySelector('script[src*="index.js"]');
        return script ? script.getAttribute("src") : "index.js";
    }

    function clearCredentialsForNewBuild() {
        try {
            const currentBuildId = getClientBuildId();
            if (localStorage.getItem(credentialsBuildKey) !== currentBuildId) {
                localStorage.removeItem(credentialsStorageKey);
                localStorage.setItem(credentialsBuildKey, currentBuildId);
            }
        } catch {
            // Local storage may be unavailable in private or locked-down browser modes.
        }
    }

    clearCredentialsForNewBuild();
    
    function getCredentials() {
        try { return JSON.parse(localStorage.getItem(credentialsStorageKey) || "[]"); }
        catch { return []; }
    }
    
    function saveCredential(user, pass) {
        if (!user || !pass) return;
        let creds = getCredentials();
        let existing = creds.find(c => c.username.toLowerCase() === user.toLowerCase());
        if (existing) { existing.password = pass; }
        else { creds.push({username: user, password: pass}); }
        localStorage.setItem(credentialsStorageKey, JSON.stringify(creds));
    }
    
    const credentialSuggestions = document.getElementById("credential-suggestions");

    function hideCredentialSuggestions() {
        credentialSuggestions.innerHTML = "";
        credentialSuggestions.classList.add("hidden");
    }

    function clearLoginState() {
        loginState.prompt = "";
        loginState.pendingUsername = "";
        loginState.autoLoginPass = "";
        hideCredentialSuggestions();
    }

    function hasUsernamePrompt(text) {
        return text.includes("By what name shall I call you?");
    }

    function hasPasswordPrompt(text) {
        return /(?:^|\n)\s*.*(?:password(?:\s+for\s+[A-Za-z0-9_]+)?|what is your password).*$/im.test(text);
    }

    function hasLoggedInGreeting(text) {
        return /^(?:welcome,|welcome back,|hello again,|hello,)\s+[A-Za-z0-9_]+/im.test(text);
    }

    function showCredentialSuggestions() {
        const creds = getCredentials();
        if (creds.length === 0) {
            hideCredentialSuggestions();
            return;
        }

        credentialSuggestions.innerHTML = "";
        creds.forEach(cred => {
            const btn = document.createElement("button");
            btn.className = "credential-btn";
            btn.innerText = `Log in as ${cred.username}`;
            btn.onclick = () => {
                loginState.pendingUsername = cred.username;
                loginState.autoLoginPass = cred.password;
                hideCredentialSuggestions();
                cmdInput.value = cred.username;
                sendCommand();
            };
            credentialSuggestions.appendChild(btn);
        });
        credentialSuggestions.classList.remove("hidden");
    }

    let currentSuggestion = "";
    let latencySamples = [];
    let resetAnchorElapsed = null;  // Server-reported elapsed seconds at anchor time
    let resetAnchorLocal = null;    // performance.now() when we anchored
    const ghostText = document.getElementById("ghost-text");
    let isConnected = false;
    let mudEventSeq = 0;
    let autocompleteTouchStart = null;
    const prefersTouchControls = window.matchMedia("(pointer: coarse)");
    const autocompleteHintText = (prefersTouchControls.matches || mobileDrawerMedia.matches) ? " Swipe right" : " Tab";
    const mobileUserAgentPattern = /Android|iPhone|iPad|iPod/i;

    function shouldUseMobileDownloadFlow() {
        return mobileDrawerMedia.matches || prefersTouchControls.matches || mobileUserAgentPattern.test(navigator.userAgent);
    }

    // Smooth 1-second reset age timer using anchored elapsed time
    setInterval(() => {
        if (resetAnchorElapsed === null || !isConnected) return;
        const localDelta = (performance.now() - resetAnchorLocal) / 1000;
        const elapsed = Math.max(0, Math.floor(resetAnchorElapsed + localDelta));
        const h = Math.floor(elapsed / 3600);
        const m = Math.floor((elapsed % 3600) / 60);
        const s = elapsed % 60;
        if (h > 0) {
            resetAgeVal.innerText = `${h}h ${m}m ${s}s`;
        } else {
            resetAgeVal.innerText = `${m}m ${s}s`;
        }
    }, 1000);

    // Helper: HTML Escaper
    function escapeHtml(text) {
        if (!text) return "";
        return text.toString()
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    class SessionLogger {
        constructor() {
            this.fileHandle = null;
            this.isLogging = false;
            this.writeQueue = [];
            this.isWriting = false;
            this.mode = null;
            this.memoryLog = [];
            this.currentSuggestedName = "BritishLegends_Log.txt";
            
            this.logBtn = document.getElementById('log-session-btn');
            this.logIndicator = document.getElementById('log-indicator');
            
            if (this.logBtn) {
                this.logBtn.addEventListener('click', () => this.toggleLogging());
            }
        }

        makeSuggestedName() {
            const now = new Date();
            const timestamp = now.getFullYear().toString() + 
                             (now.getMonth() + 1).toString().padStart(2, '0') + 
                             now.getDate().toString().padStart(2, '0') + "_" + 
                             now.getHours().toString().padStart(2, '0') + 
                             now.getMinutes().toString().padStart(2, '0') + 
                             now.getSeconds().toString().padStart(2, '0');
            
            const charName = typeof myName !== 'undefined' && myName ? myName : "Log";
            return `${timestamp}_BritishLegends_${charName}.txt`;
        }

        cleanLogText(text) {
            let cleanText = text.replace(/<[^>]*>?/gm, '');
            cleanText = cleanText.replace(/\x1b\[[0-9;]*[mK]/g, "");
            return cleanText.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
        }

        setLoggingUi(active) {
            if (!this.logBtn || !this.logIndicator) return;
            this.logBtn.innerText = active ? "Stop Logging" : "Log Session";
            this.logIndicator.classList.toggle('hidden', !active);
        }

        async toggleLogging() {
            if (this.isLogging) {
                await this.stopLogging();
            } else {
                await this.startLogging();
            }
        }

        async startLogging() {
            try {
                const dynamicSuggestedName = this.makeSuggestedName();
                this.currentSuggestedName = dynamicSuggestedName;
                this.memoryLog = [];
                this.writeQueue = [];
                this.fileHandle = null;
                this.mode = window.showSaveFilePicker && !shouldUseMobileDownloadFlow() ? "file" : "download";

                if (this.mode === "file") {
                    this.fileHandle = await window.showSaveFilePicker({
                        suggestedName: dynamicSuggestedName,
                        id: 'mud-session-logs',
                        types: [{
                            description: 'Text Files',
                            accept: {'text/plain': ['.txt']}
                        }]
                    });
                }
                
                this.isLogging = true;
                this.setLoggingUi(true);
                
                // Write a header
                this.logText(`--- Session Log Started: ${new Date().toLocaleString()} ---\n`);
            } catch (error) {
                console.error("Logging cancelled or failed:", error);
                this.isLogging = false;
                this.fileHandle = null;
                this.mode = null;
                this.memoryLog = [];
                this.setLoggingUi(false);
            }
        }

        async stopLogging() {
            if (this.isLogging) {
                this.logText(`--- Session Log Ended: ${new Date().toLocaleString()} ---\n`);
            }
            
            if (this.mode === "file") {
                await this.flushQueue();
            } else if (this.mode === "download") {
                this.downloadMemoryLog();
            }

            this.isLogging = false;
            this.fileHandle = null;
            this.mode = null;
            
            this.setLoggingUi(false);
        }

        logText(text) {
            if (!this.isLogging) return;
            
            // Ensure Windows-style newlines for local txt logs.
            const cleanText = this.cleanLogText(text);

            if (this.mode === "download") {
                this.memoryLog.push(cleanText);
                return;
            }

            if (!this.fileHandle) return;
            
            this.writeQueue.push(cleanText);
            this.processQueue();
        }

        downloadMemoryLog() {
            const textToDownload = this.memoryLog.join("");
            if (!textToDownload) return;

            const blob = new Blob([textToDownload], {type: "text/plain;charset=utf-8"});
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = this.currentSuggestedName || "BritishLegends_Log.txt";
            link.style.display = "none";
            document.body.appendChild(link);
            link.click();
            setTimeout(() => {
                URL.revokeObjectURL(url);
                link.remove();
            }, 1000);
        }

        async flushQueue() {
            while (this.isWriting) {
                await new Promise(resolve => setTimeout(resolve, 25));
            }

            if (this.writeQueue.length > 0) {
                await this.processQueue();
            }
        }

        async processQueue() {
            if (this.isWriting || this.writeQueue.length === 0) return;
            this.isWriting = true;
            
            try {
                const textToWrite = this.writeQueue.join("");
                this.writeQueue = [];
                
                const file = await this.fileHandle.getFile();
                const offset = file.size;
                
                const writable = await this.fileHandle.createWritable({keepExistingData: true});
                await writable.write({ type: "write", position: offset, data: textToWrite });
                await writable.close();
            } catch (error) {
                console.error("Error writing to log file:", error);
                // Stop logging if write fails (e.g., file was locked or deleted)
                this.isLogging = false;
                this.fileHandle = null;
                this.mode = null;
                this.memoryLog = [];
                this.setLoggingUi(false);
            } finally {
                this.isWriting = false;
                if (this.writeQueue.length > 0 && this.isLogging) {
                    this.processQueue();
                }
            }
        }
    }

    const sessionLogger = new SessionLogger();

    function setSnoopCollapsed(collapsed) {
        isSnoopCollapsed = collapsed;
        const isActive = snoopPanel.classList.contains("active");
        snoopPanel.classList.toggle("collapsed", collapsed && isActive);
        document.body.classList.toggle("snoop-overlay-open", isActive && !collapsed);
        setSnoopMenuDocked(isActive && !collapsed);
        closeSnoopBtn.textContent = collapsed ? "+" : "-";
        closeSnoopBtn.title = collapsed ? "Show Snoop Feed" : "Hide Snoop Feed";
        closeSnoopBtn.setAttribute("aria-label", closeSnoopBtn.title);
        closeSnoopBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");

        if (isActive && !collapsed) {
            snoopResizer.classList.add("active");
        } else {
            snoopResizer.classList.remove("active");
        }
    }

    function activateSnoopPanel() {
        snoopPanel.classList.add("active");
        setSnoopCollapsed(isSnoopCollapsed);
    }

    function resetSnoopPanel() {
        snoopPanel.classList.remove("active", "collapsed");
        snoopResizer.classList.remove("active");
        document.body.classList.remove("snoop-overlay-open");
        setSnoopMenuDocked(false);
        setSnoopCollapsed(false);
    }

    // Helper: Append text to terminal and scroll
    function appendTerminalText(text) {
        if (!text) return;
        
        // Write to local session log if active
        sessionLogger.logText(text);
        
        // Check if user is scrolled near bottom (within 45px)
        const isNearBottom = terminalScreen.scrollHeight - terminalScreen.scrollTop - terminalScreen.clientHeight < 45;
        const snoopNearBottom = snoopContent.scrollHeight - snoopContent.scrollTop - snoopContent.clientHeight < 45;
        
        // Clean carriage returns
        let formatted = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        // Strip ANSI escape sequences if any exist
        formatted = formatted.replace(/\x1b\[[0-9;]*[mK]/g, "");

        const lines = formatted.split("\n");
        lines.forEach((line, index) => {
            const isEndOfChunk = (index === lines.length - 1);
            const canRouteToSnoop = Boolean(activeSnoopTarget);
            
            // Determine if this line belongs to Snoop feed or Main terminal
            if (!canRouteToSnoop) {
                isSnoopingLine = false;
            }

            if (!isEndOfChunk || line.length > 0) {
                if (canRouteToSnoop && !isSnoopingLine && line.startsWith("|")) {
                    isSnoopingLine = true;
                    line = line.substring(1); // Remove the pipe character itself
                    activateSnoopPanel();
                } else if (canRouteToSnoop && isSnoopingLine && line.startsWith("|")) {
                    line = line.substring(1); // Already snooping, remove extra pipe if present
                }
            }

            const trimmed = line.trim();
            // Force reset snoop if we see the user's recent command echo, or a main prompt
            if (lastSentCommand && trimmed.toLowerCase() === lastSentCommand.toLowerCase()) {
                isSnoopingLine = false;
                lastSentCommand = ""; // Only match once
            } else if (trimmed === "*" || trimmed === "(----*)") {
                isSnoopingLine = false;
            }

            const targetScreen = canRouteToSnoop && isSnoopingLine ? snoopContent : terminalScreen;

            const lineSpan = document.createElement("span");
            // Only append a newline if it was actually present in the original text chunk
            lineSpan.textContent = line + (!isEndOfChunk ? "\n" : "");
            targetScreen.appendChild(lineSpan);
            
            // Turn off snooping for subsequent lines if we hit a blank line (might be end of snoop block)
            if (canRouteToSnoop && isSnoopingLine && !isEndOfChunk && trimmed === "") {
                isSnoopingLine = false;
            }
        });
        
        // Auto scroll to bottom
        if (isNearBottom || terminalScreen.children.length <= 10) {
            terminalScreen.scrollTop = terminalScreen.scrollHeight;
        }
        if (snoopPanel.classList.contains("active") && (snoopNearBottom || snoopContent.children.length <= 10)) {
            snoopContent.scrollTop = snoopContent.scrollHeight;
        }
    }

    async function submitCommand(rawCommand, options = {}) {
        const command = (rawCommand || "").trim();
        if (!command) return;
        
        const {
            handleLogin = false,
            clearInput = false,
            focusInput = true,
            addToHistory = true
        } = options;

        lastSentCommand = command;
        
        // Force reset snoop tracking so user input/echo returns to main terminal
        isSnoopingLine = false;
        
        // Remember username or password for multi-account
        if (handleLogin && loginState.prompt === "username") {
            loginState.pendingUsername = command;
            loginState.prompt = "awaitingPassword";
            hideCredentialSuggestions();
        } else if (handleLogin && (loginState.prompt === "password" || loginState.prompt === "awaitingPassword")) {
            if (loginState.pendingUsername) {
                saveCredential(loginState.pendingUsername, command);
            }
            clearLoginState();
        }
        
        // Add to history
        if (addToHistory) {
            commandHistory.push(command);
            if (commandHistory.length > 100) {
                commandHistory.shift();
            }
            historyIndex = -1;
        }
        
        if (clearInput) {
            // Clear input field and ghost text
            cmdInput.value = "";
            ghostText.innerHTML = "";
            currentSuggestion = "";
        }
        
        // Return focus to the input box so the user can keep typing
        if (focusInput) {
            cmdInput.focus();
        }
        
        try {
            const response = await fetch("/command", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ command })
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                const message = data.error || `Command failed: ${response.statusText}`;
                console.error("Failed to send command:", message);
                appendTerminalText(`\n[System Error: ${message}]\n`);
            }
        } catch (err) {
            console.error("Error sending command:", err);
            appendTerminalText(`\n[System Error: Connection to backend server failed while sending command.]\n`);
        }
    }

    // Send Command to Backend
    async function sendCommand() {
        await submitCommand(cmdInput.value, {
            handleLogin: true,
            clearInput: true,
            focusInput: true
        });
    }
    // Reconnect to MUD
    async function reconnectMud() {
        appendTerminalText(`\n[System: Sending reconnect command to MUD server...]\n`);
        try {
            const response = await fetch("/reconnect", { method: "POST" });
            if (response.ok) {
                appendTerminalText(`[System: Reconnect request accepted by server. Reconnecting...]\n`);
            } else {
                appendTerminalText(`[System Error: Reconnect request failed: ${response.statusText}]\n`);
            }
        } catch (err) {
            console.error("Error reconnecting:", err);
            appendTerminalText(`[System Error: Network connection to web server failed during reconnect request.]\n`);
        }
    }

    reconnectBtn.addEventListener("click", reconnectMud);
    sendCmdBtn.addEventListener("click", sendCommand);
    
    if (clearTellsBtn) {
        clearTellsBtn.addEventListener("click", async () => {
            try {
                await fetch("/clear_tells", { method: "POST" });
                tellList.innerHTML = '<li class="empty-list">No tells received yet.</li>';
                knownTellsCount = 0;
            } catch (err) {
                console.error("Error clearing tells:", err);
            }
        });
    }
    
    closeSnoopBtn.addEventListener("click", () => {
        if (!snoopPanel.classList.contains("active")) return;
        setSnoopCollapsed(!isSnoopCollapsed);
        if (!isSnoopCollapsed) {
            snoopContent.scrollTop = snoopContent.scrollHeight;
        }
        isSnoopingLine = false;
    });
    
    // Autocomplete: commands that take a player name as argument
    const playerCommands = ['snoop', 'tell', 'follow', 'summon', 'force', 'where', 'vis', 'invis', 'set', 'fod', 'finger', 'bug', 'proof'];

    function getAutocompleteSuggestion(text) {
        if (!text || cachedKnownPlayers.length === 0) return "";
        const parts = text.split(/\s+/);
        if (parts.length < 2) return "";
        const cmd = parts[0].toLowerCase();
        if (!playerCommands.some(pc => pc.startsWith(cmd))) return "";

        // Only autocomplete the last word (the player name fragment)
        const fragment = parts[parts.length - 1].toLowerCase();
        if (!fragment) return "";

        const match = cachedKnownPlayers.find(p =>
            p.toLowerCase().startsWith(fragment) && p.toLowerCase() !== fragment
        );

        if (match) {
            // Return the full line with the completed name
            const prefix = parts.slice(0, -1).join(' ') + ' ';
            const suffix = ", ";
            return prefix + match + suffix;
        }
        return "";
    }

    function updateGhostText() {
        const text = cmdInput.value;
        currentSuggestion = getAutocompleteSuggestion(text);
        if (currentSuggestion) {
            // Split into typed part (transparent) and remaining part (visible)
            // to prevent overlapping character messiness (like lowercase 's' over uppercase 'S')
            const typedLength = text.length;
            const typedPart = currentSuggestion.substring(0, typedLength);
            const remainingPart = currentSuggestion.substring(typedLength);
            
            ghostText.innerHTML = `<span style="opacity: 0;">${escapeHtml(typedPart)}</span>${escapeHtml(remainingPart)}<span class="ghost-hint">${autocompleteHintText}</span>`;
        } else {
            ghostText.innerHTML = "";
        }
    }

    function acceptAutocompleteSuggestion() {
        if (!currentSuggestion) return false;
        cmdInput.value = currentSuggestion;
        ghostText.innerHTML = "";
        currentSuggestion = "";
        cmdInput.focus();
        const cursorPosition = cmdInput.value.length;
        requestAnimationFrame(() => {
            cmdInput.setSelectionRange(cursorPosition, cursorPosition);
        });
        if (navigator.vibrate) {
            navigator.vibrate(8);
        }
        return true;
    }

    cmdInput.addEventListener("input", () => {
        updateGhostText();
    });

    cmdInput.addEventListener("keydown", (e) => {
        if (e.key === "Tab") {
            // Accept autocomplete suggestion
            if (acceptAutocompleteSuggestion()) {
                e.preventDefault();
            }
        } else if (e.key === "Enter") {
            sendCommand();
        } else if (e.key === "ArrowUp") {
            // Traverse history backward
            if (commandHistory.length > 0) {
                if (historyIndex === -1) {
                    historyIndex = commandHistory.length - 1;
                } else if (historyIndex > 0) {
                    historyIndex--;
                }
                cmdInput.value = commandHistory[historyIndex];
                ghostText.innerHTML = "";
                currentSuggestion = "";
                setTimeout(() => {
                    cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length);
                }, 0);
            }
            e.preventDefault();
        } else if (e.key === "ArrowDown") {
            // Traverse history forward
            if (historyIndex !== -1) {
                if (historyIndex < commandHistory.length - 1) {
                    historyIndex++;
                    cmdInput.value = commandHistory[historyIndex];
                } else {
                    historyIndex = -1;
                    cmdInput.value = "";
                }
            }
            ghostText.innerHTML = "";
            currentSuggestion = "";
            e.preventDefault();
        } else if (e.key === "Escape") {
            cmdInput.value = "";
            ghostText.innerHTML = "";
            currentSuggestion = "";
            historyIndex = -1;
            e.preventDefault();
        }
    });

    const autocompleteSwipeTarget = cmdInput.closest(".input-container");
    if (autocompleteSwipeTarget) {
        autocompleteSwipeTarget.addEventListener("touchstart", (event) => {
            if (!currentSuggestion || event.touches.length !== 1) {
                autocompleteTouchStart = null;
                return;
            }
            const touch = event.touches[0];
            autocompleteTouchStart = {
                x: touch.clientX,
                y: touch.clientY,
                time: performance.now()
            };
        }, { passive: true });

        autocompleteSwipeTarget.addEventListener("touchend", (event) => {
            if (!autocompleteTouchStart || !currentSuggestion || event.changedTouches.length !== 1) return;

            const touch = event.changedTouches[0];
            const dx = touch.clientX - autocompleteTouchStart.x;
            const dy = touch.clientY - autocompleteTouchStart.y;
            const elapsed = performance.now() - autocompleteTouchStart.time;
            autocompleteTouchStart = null;

            if (dx > 56 && Math.abs(dy) < 40 && elapsed < 900) {
                event.preventDefault();
                acceptAutocompleteSuggestion();
            }
        }, { passive: false });

        autocompleteSwipeTarget.addEventListener("touchcancel", () => {
            autocompleteTouchStart = null;
        }, { passive: true });
    }

    // Make player lists clickable to easily target players
    document.addEventListener("click", (e) => {
        const playerItem = e.target.closest("li");
        if (playerItem && (onlinePlayersList.contains(playerItem) || offlinePlayersList.contains(playerItem))) {
            const nameSpan = playerItem.querySelector(".player-name");
            if (nameSpan) {
                const name = nameSpan.textContent;
                // Add a space after the name to make it easy to type "kill [name] " or just "[name] "
                cmdInput.value += (cmdInput.value && !cmdInput.value.endsWith(" ") ? " " : "") + name + " ";
                cmdInput.focus();
                updateGhostText();
            }
        }
    });
    // -----------------------------------------
    // Resizer Logic for Snoop Panel
    // -----------------------------------------
    let isResizing = false;

    snoopResizer.addEventListener("mousedown", (e) => {
        isResizing = true;
        snoopResizer.classList.add("dragging");
        document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", (e) => {
        if (!isResizing) return;
        
        const containerRect = document.querySelector(".screens-container").getBoundingClientRect();
        let newWidth = containerRect.right - e.clientX;
        if (newWidth < 200) newWidth = 200;
        if (newWidth > containerRect.width - 300) newWidth = containerRect.width - 300;

        snoopPanel.style.flex = `0 0 ${newWidth}px`;
    });

    document.addEventListener("mouseup", () => {
        if (isResizing) {
            isResizing = false;
            snoopResizer.classList.remove("dragging");
            document.body.style.userSelect = "";
        }
    });

    // -----------------------------------------
    // Resizer Logic for Sidebar (Tell / Players)
    // -----------------------------------------
    const sidebarResizer = document.getElementById("sidebar-resizer");
    const tellCard = document.getElementById("tell-card");
    const playersCard = document.getElementById("players-card");
    let isSidebarResizing = false;

    sidebarResizer.addEventListener("mousedown", (e) => {
        isSidebarResizing = true;
        sidebarResizer.classList.add("dragging");
        document.body.style.userSelect = "none";
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!isSidebarResizing) return;

        const area = document.querySelector(".sidebar-resizable-area");
        const areaRect = area.getBoundingClientRect();
        let tellHeight = e.clientY - areaRect.top;

        // Clamp: min 60px for each card
        const minCard = 60;
        const resizerHeight = 10;
        if (tellHeight < minCard) tellHeight = minCard;
        if (tellHeight > areaRect.height - resizerHeight - minCard) {
            tellHeight = areaRect.height - resizerHeight - minCard;
        }

        tellCard.style.flex = "none";
        tellCard.style.height = tellHeight + "px";
        playersCard.style.flex = "1";
    });

    document.addEventListener("mouseup", () => {
        if (isSidebarResizing) {
            isSidebarResizing = false;
            sidebarResizer.classList.remove("dragging");
            document.body.style.userSelect = "";
        }
    });

    // Update Player List UI Elements
    function updatePlayerLists(online, offline, levels) {
        // Online players
        countOnline.innerText = online.length;
        if (online.length === 0) {
            onlinePlayersList.innerHTML = `<li class="empty-list">No players detected yet. Type 'qu' to see who's online.</li>`;
        } else {
            // Sort case-insensitively
            const sorted = [...online].sort((a, b) => {
                return a.toLowerCase().localeCompare(b.toLowerCase());
            });
            
            onlinePlayersList.innerHTML = sorted.map(player => {
                const isMe = myName && player.toLowerCase() === myName.toLowerCase();
                let badge = '';
                if (isMe) {
                    badge = ' <span class="me-badge">(You)</span>';
                }
                const level = levels[player] ? ` <span class="player-level">[${escapeHtml(levels[player])}]</span>` : '';
                return `<li${isMe ? ' class="is-me"' : ''}><span class="status-dot"></span><span class="player-name">${escapeHtml(player)}</span>${badge}${level}</li>`;
            }).join('');
        }

        // Offline players
        countOffline.innerText = offline.length;
        if (offline.length === 0) {
            offlinePlayersList.innerHTML = `<li class="empty-list">No logged off players recorded yet.</li>`;
        } else {
            offlinePlayersList.innerHTML = offline.map(player => {
                const level = levels[player] ? ` <span class="player-level">[${escapeHtml(levels[player])}]</span>` : '';
                return `<li><span class="status-dot"></span><span class="player-name">${escapeHtml(player)}</span>${level}</li>`;
            }).join('');
        }
    }



    // Main Update Poller
    async function pollUpdates() {
        const startTime = performance.now();
        try {
            const response = await fetch(`/updates?since=${mudEventSeq}`);
            if (!response.ok) throw new Error(response.statusText);
            
            const data = await response.json();
            if (Number.isFinite(data.mud_event_seq)) {
                mudEventSeq = data.mud_event_seq;
            }
            
            // Calculate and display rolling average latency
            const endTime = performance.now();
            const rawLatency = Math.round(endTime - startTime);
            
            if (data.is_connected) {
                isConnected = true;
                latencySamples.push(rawLatency);
                if (latencySamples.length > 10) latencySamples.shift(); // Keep last 10 samples
                const avgLatency = Math.round(latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length);
                latencyVal.innerText = `${avgLatency}ms`;
                latencyVal.style.color = "var(--gold-highlight)";
                
                // Connection indicator glows green
                pulseIndicator.className = "pulse-indicator connected";
            } else {
                isConnected = false;
                // Leave latency at the last known value, just dim it
                pulseIndicator.className = "pulse-indicator";
                latencyVal.style.color = "var(--color-text-muted)";
            }
            
            // Snoop Target
            if (data.snoop_target) {
                activeSnoopTarget = data.snoop_target;
                snoopTitleText.innerText = `SNOOP FEED: ${data.snoop_target}`;
            } else {
                activeSnoopTarget = "";
                if (snoopTitleText.innerText !== `SNOOP FEED` || snoopPanel.classList.contains("active")) {
                    snoopTitleText.innerText = `SNOOP FEED`;
                    snoopContent.innerHTML = '';
                    resetSnoopPanel();
                    isSnoopingLine = false;
                }
            }

            // 1. Terminal screen output
            if (data.mud_output) {
                appendTerminalText(data.mud_output);

                // Detect login prompts for auto-fill
                const sawUsernamePrompt = hasUsernamePrompt(data.mud_output);
                const sawPasswordPrompt = hasPasswordPrompt(data.mud_output);
                const sawLoggedInGreeting = hasLoggedInGreeting(data.mud_output);

                if (sawLoggedInGreeting) {
                    clearLoginState();
                } else if (sawUsernamePrompt) {
                    loginState.prompt = "username";
                    loginState.pendingUsername = "";
                    loginState.autoLoginPass = "";
                    showCredentialSuggestions();
                } else if (sawPasswordPrompt && loginState.pendingUsername) {
                    loginState.prompt = "password";
                    hideCredentialSuggestions();
                    if (loginState.autoLoginPass) {
                        cmdInput.value = loginState.autoLoginPass;
                        sendCommand();
                    }
                }
            }
            
            // 4. Reset age - anchor elapsed time from server, tick locally
            if (data.reset_elapsed != null && data.is_connected) {
                const localDelta = resetAnchorLocal ? (performance.now() - resetAnchorLocal) / 1000 : 0;
                const localProjected = resetAnchorElapsed !== null ? resetAnchorElapsed + localDelta : null;
                
                // Only re-anchor if we drift by more than 2 seconds to prevent stuttering
                if (resetAnchorElapsed === null || data.reset_elapsed < resetAnchorElapsed || (localProjected !== null && Math.abs(data.reset_elapsed - localProjected) > 2)) {
                    resetAnchorElapsed = data.reset_elapsed;
                    resetAnchorLocal = performance.now();
                }
                // Do not render here! Let setInterval render to prevent stuttering.
                resetAgeVal.style.color = "var(--gold-highlight)";
            } else if (data.reset_elapsed === null && data.is_connected) {
                resetAgeVal.innerText = "--m --s";
                resetAnchorElapsed = null;
                resetAgeVal.style.color = "var(--gold-highlight)";
            } else if (!data.is_connected) {
                // Keep the last text value, dim it to show it's paused
                resetAgeVal.style.color = "var(--color-text-muted)";
            }
            // 5. Stats
            if (data.level) {
                statLevel.innerText = data.level;
            }
            if (data.stats) {
                statStamina.innerText = data.stats.stamina;
                
                // Stamina progress bar percentage
                if (data.stats.stamina_max > 0) {
                    const percent = Math.max(0, Math.min(100, Math.round((data.stats.stamina_val / data.stats.stamina_max) * 100)));
                    staminaProgress.style.width = `${percent}%`;
                    
                    // Adjust color gradient based on stamina level
                    if (percent < 25) {
                        staminaProgress.style.background = "linear-gradient(90deg, var(--neon-red), #ff7788)";
                        staminaProgress.style.boxShadow = "0 0 8px rgba(255, 51, 102, 0.6)";
                    } else if (percent < 50) {
                        staminaProgress.style.background = "linear-gradient(90deg, var(--neon-gold), #ffdd66)";
                        staminaProgress.style.boxShadow = "0 0 8px rgba(255, 170, 0, 0.6)";
                    } else {
                        staminaProgress.style.background = "linear-gradient(90deg, var(--neon-green), #99ffaa)";
                        staminaProgress.style.boxShadow = "0 0 8px rgba(0, 255, 102, 0.6)";
                    }
                } else {
                    staminaProgress.style.width = "0%";
                }
            }

            // Tell Window Updates
            if (data.tells && data.tells.length > knownTellsCount) {
                // If this is the first tell, clear the empty list placeholder
                if (knownTellsCount === 0) {
                    tellList.innerHTML = '';
                }
                
                // Append only the new tells
                for (let i = knownTellsCount; i < data.tells.length; i++) {
                    const tell = data.tells[i];
                    const li = document.createElement("li");
                    li.className = "tell-item";
                    
                    if (tell.type === "sent") {
                        li.innerHTML = `<span class="tell-prefix">To ${escapeHtml(tell.to)}:</span> <span class="tell-sent">${escapeHtml(tell.message)}</span>`;
                    } else if (tell.type === "received") {
                        li.innerHTML = `<span class="tell-prefix">From ${escapeHtml(tell.from)}:</span> <span class="tell-received">${escapeHtml(tell.message)}</span>`;
                    }
                    
                    tellList.appendChild(li);
                }
                
                knownTellsCount = data.tells.length;
                
                // Auto-scroll to bottom of tell list
                const tellContainer = tellList.parentElement;
                tellContainer.scrollTop = tellContainer.scrollHeight;
            }


            
            // 6. Player Lists
            if (data.my_name) {
                myName = data.my_name;
            }
            if (!myName) {
                if (loginState.pendingUsername) {
                    myName = loginState.pendingUsername;
                } else {
                    const creds = getCredentials();
                    myName = creds.length > 0 ? creds[creds.length - 1].username : "";
                }
                if (myName) {
                    myName = myName.charAt(0).toUpperCase() + myName.slice(1).toLowerCase();
                }
            }
            if (myName) {
                charNameTitle.innerText = " - " + myName;
            } else {
                charNameTitle.innerText = "";
            }
            cachedKnownPlayers = [...(data.players_online || []), ...(data.players_offline || [])];
            updatePlayerLists(data.players_online || [], data.players_offline || [], data.player_levels || {});
            
            // 7. Advanced Trackers (Sleep & Combat)
            if (data.is_sleeping) {
                sleepOverlay.style.display = "flex";
            } else {
                sleepOverlay.style.display = "none";
            }

            if (data.in_combat) {
                combatHud.style.display = "block";
                if (data.combat_logs && data.combat_logs.length > 0) {
                    combatLogList.innerHTML = data.combat_logs.map(log => `<li>${escapeHtml(log)}</li>`).join('');
                    combatLogList.scrollTop = combatLogList.scrollHeight;
                }
            } else {
                combatHud.style.display = "none";
            }
        } catch (err) {
            console.error("Polling error:", err);
            
            // Only trigger the full disconnected UI state if we were previously connected
            if (pulseIndicator.className !== "pulse-indicator disconnected") {
                pulseIndicator.className = "pulse-indicator disconnected";
                latencyVal.innerText = "offline";
                latencyVal.style.color = "var(--neon-red)";
                
                // Clear UI state
                statStamina.innerText = "--/--";
                staminaProgress.style.width = "0%";
                updatePlayerLists([], [], {});
                
                // Print a visual warning in the terminal
                const sysLine = document.createElement("div");
                sysLine.style.color = "var(--neon-red)";
                sysLine.style.marginTop = "10px";
                sysLine.innerText = "\n[System: Lost connection to local Python backend (web_server.py).]";
                outputDiv.appendChild(sysLine);
                outputDiv.scrollTop = outputDiv.scrollHeight;
            }
        }
    }

    // Macros Logic
    let savedMacros = null;
    try {
        savedMacros = JSON.parse(localStorage.getItem('mudMacros') || 'null');
    } catch (error) {
        localStorage.removeItem('mudMacros');
    }
    const legacyDefaultMacros = [
        { label: "Exits", cmd: "exits" }, { label: "S", cmd: "s" }, { label: "Down", cmd: "d" },
        { label: "Score", cmd: "sc" }, { label: "Stats", cmd: "st" }, { label: "Who", cmd: "who" },
        { label: "Smile", cmd: "smile" }, { label: "Flee", cmd: "flee o" }, { label: "Quit", cmd: "quit" },
        { label: "M1", cmd: "" }, { label: "M2", cmd: "" }, { label: "M3", cmd: "" }
    ];
    let defaultMacros = Array.from({length: 12}, (_, index) => ({
        label: `M${index + 1}`,
        cmd: ""
    }));
    function matchesLegacyMacro(macro, legacyMacro) {
        return macro && macro.label === legacyMacro.label && macro.cmd === legacyMacro.cmd;
    }
    function containsLegacyMacroSet(source) {
        if (!Array.isArray(source) || source.length < legacyDefaultMacros.length) return false;
        for (let start = 0; start <= source.length - legacyDefaultMacros.length; start++) {
            if (legacyDefaultMacros.every((legacyMacro, index) => matchesLegacyMacro(source[start + index], legacyMacro))) {
                return true;
            }
        }
        return false;
    }
    if (savedMacros) {
        if (savedMacros.length === 18) {
            savedMacros = savedMacros.slice(6);
        }
        const isLegacyDefaultSet = savedMacros.length === 12 && savedMacros.every((macro, index) => matchesLegacyMacro(macro, legacyDefaultMacros[index]));

        if (isLegacyDefaultSet || containsLegacyMacroSet(savedMacros)) {
            localStorage.removeItem('mudMacros');
        } else {
            for (let i = 0; i < savedMacros.length && i < 12; i++) {
                defaultMacros[i] = savedMacros[i];
            }
        }
    }
    let macros = defaultMacros;

    function renderMacros() {
        macrosGrid.innerHTML = '';
        macros.forEach((macro, index) => {
            const wrapper = document.createElement("div");
            wrapper.className = "macro-btn-wrapper";

            const btn = document.createElement("button");
            btn.className = "macro-btn";
            btn.innerText = macro.label;
            
            // Edit Panel
            const editPanel = document.createElement("div");
            editPanel.className = `macro-edit-panel ${isEditingMacros ? 'active' : ''}`;
            
            const labelInput = document.createElement("input");
            labelInput.type = "text";
            labelInput.value = macro.label;
            labelInput.placeholder = "Label";

            const cmdInput = document.createElement("input");
            cmdInput.type = "text";
            cmdInput.value = macro.cmd;
            cmdInput.placeholder = "Command";

            const saveBtn = document.createElement("button");
            saveBtn.innerText = "Save";

            saveBtn.onclick = () => {
                macros[index].label = labelInput.value.trim() || `M${index + 1}`;
                macros[index].cmd = cmdInput.value.trim();
                localStorage.setItem('mudMacros', JSON.stringify(macros));
                renderMacros();
            };

            editPanel.appendChild(labelInput);
            editPanel.appendChild(cmdInput);
            editPanel.appendChild(saveBtn);

            btn.onclick = async () => {
                if (isEditingMacros) return;

                const macroCommand = (macro.cmd || "").trim();
                if (!macroCommand) {
                    appendTerminalText(`\n[System: Macro "${macro.label}" has no command assigned.]\n`);
                    setMobileMenuOpen(false);
                    return;
                }

                await submitCommand(macroCommand, {
                    handleLogin: false,
                    clearInput: false,
                    focusInput: true
                });

                setMobileMenuOpen(false);
            };

            wrapper.appendChild(btn);
            wrapper.appendChild(editPanel);
            macrosGrid.appendChild(wrapper);
        });
    }

    editMacrosBtn.addEventListener("click", () => {
        isEditingMacros = !isEditingMacros;
        editMacrosBtn.style.color = isEditingMacros ? "var(--gold-highlight)" : "";
        if (isEditingMacros) {
            macrosGrid.classList.add("editing");
        } else {
            macrosGrid.classList.remove("editing");
        }
        renderMacros();
    });

    const importMacrosBtn = document.getElementById("import-macros-btn");
    const exportMacrosBtn = document.getElementById("export-macros-btn");

    function downloadTextFile(filename, contents, mimeType = "text/plain;charset=utf-8") {
        const blob = new Blob([contents], {type: mimeType});
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        setTimeout(() => {
            URL.revokeObjectURL(url);
            link.remove();
        }, 1000);
    }

    function pickMacroFileFromInput() {
        return new Promise((resolve) => {
            const input = document.createElement("input");
            input.type = "file";
            // Mobile exports use .txt so Android filters out screenshots and other media noise.
            input.accept = ".txt,.json,text/plain,application/json";
            input.style.display = "none";
            input.addEventListener("change", () => {
                const file = input.files && input.files[0] ? input.files[0] : null;
                input.remove();
                resolve(file);
            }, {once: true});
            document.body.appendChild(input);
            input.click();
        });
    }

    function normalizeImportedMacros(imported) {
        if (!Array.isArray(imported)) return null;
        const source = imported.length === 18 ? imported.slice(6) : imported;
        const normalized = [];

        for (let i = 0; i < source.length && i < 12; i++) {
            const macro = source[i] || {};
            normalized.push({
                label: String(macro.label || `M${i + 1}`),
                cmd: String(macro.cmd || "")
            });
        }

        return normalized.length > 0 ? normalized : null;
    }

    function applyImportedMacros(imported) {
        const normalized = normalizeImportedMacros(imported);
        if (!normalized) {
            appendTerminalText(`\n[System: Invalid macro file format.]\n`);
            return false;
        }

        macros = normalized;
        localStorage.setItem('mudMacros', JSON.stringify(macros));
        renderMacros();
        appendTerminalText(`\n[System: Loaded ${macros.length} macros.]\n`);
        return true;
    }

    async function exportMacros() {
        const contents = JSON.stringify(macros, null, 2);
        const desktopFilename = "mud_macros.json";
        const mobileFilename = "british_legends_macros.txt";

        try {
            if (!window.showSaveFilePicker) {
                downloadTextFile(mobileFilename, contents);
                appendTerminalText(`\n[System: Macro backup downloaded as ${mobileFilename}. On Android, load it from Downloads.]\n`);
                return;
            }

            const handle = await window.showSaveFilePicker({
                suggestedName: desktopFilename,
                types: [{
                    description: 'Macro Files',
                    accept: {
                        'application/json': ['.json'],
                        'text/plain': ['.txt']
                    },
                }],
            });
            const writable = await handle.createWritable();
            await writable.write(contents);
            await writable.close();
        } catch (err) {
            console.error("Export cancelled or failed", err);
            appendTerminalText(`\n[System: Macro export cancelled or failed.]\n`);
        }
    }

    async function importMacros() {
        try {
            let file = null;

            if (window.showOpenFilePicker) {
                const [fileHandle] = await window.showOpenFilePicker({
                    types: [{
                        description: 'Macro Files',
                        accept: {
                            'application/json': ['.json'],
                            'text/plain': ['.txt']
                        },
                    }],
                });
                file = await fileHandle.getFile();
            } else {
                file = await pickMacroFileFromInput();
            }

            if (!file) return;

            const contents = await file.text();
            const imported = JSON.parse(contents);
            applyImportedMacros(imported);
        } catch (err) {
            console.error("Import cancelled or failed", err);
            appendTerminalText(`\n[System: Macro import cancelled or failed.]\n`);
        }
    }

    exportMacrosBtn.addEventListener("click", exportMacros);
    importMacrosBtn.addEventListener("click", importMacros);

    // Initial render
    renderMacros();

    // Run first poll instantly, then poll after each response completes
    // Using setTimeout (not setInterval) prevents request pileup when the server is slow
    function startPolling() {
        pollUpdates().finally(() => {
            setTimeout(startPolling, 500);
        });
    }
    // How to Play Guide Modal Logic
    const guideBtn = document.getElementById('guide-btn');
    const guideModalOverlay = document.getElementById('guide-modal-overlay');
    const closeGuideBtn = document.getElementById('close-guide-btn');

    if (guideBtn && guideModalOverlay && closeGuideBtn) {
        guideBtn.addEventListener('click', () => {
            guideModalOverlay.classList.remove('hidden');
        });

        closeGuideBtn.addEventListener('click', () => {
            guideModalOverlay.classList.add('hidden');
        });

        // Click outside to close
        guideModalOverlay.addEventListener('click', (e) => {
            if (e.target === guideModalOverlay) {
                guideModalOverlay.classList.add('hidden');
            }
        });
    }

    // Tips for Players Modal Logic
    const tipsBtn = document.getElementById('tips-btn');
    const tipsModalOverlay = document.getElementById('tips-modal-overlay');
    const closeTipsBtn = document.getElementById('close-tips-btn');

    if (tipsBtn && tipsModalOverlay && closeTipsBtn) {
        tipsBtn.addEventListener('click', () => {
            tipsModalOverlay.classList.remove('hidden');
        });

        closeTipsBtn.addEventListener('click', () => {
            tipsModalOverlay.classList.add('hidden');
        });

        // Click outside to close
        tipsModalOverlay.addEventListener('click', (e) => {
            if (e.target === tipsModalOverlay) {
                tipsModalOverlay.classList.add('hidden');
            }
        });
    }

    // FAQ Modal Logic
    const faqBtn = document.getElementById('faq-btn');
    const faqModalOverlay = document.getElementById('faq-modal-overlay');
    const closeFaqBtn = document.getElementById('close-faq-btn');

    if (faqBtn && faqModalOverlay && closeFaqBtn) {
        faqBtn.addEventListener('click', () => {
            faqModalOverlay.classList.remove('hidden');
        });

        closeFaqBtn.addEventListener('click', () => {
            faqModalOverlay.classList.add('hidden');
        });

        // Click outside to close
        faqModalOverlay.addEventListener('click', (e) => {
            if (e.target === faqModalOverlay) {
                faqModalOverlay.classList.add('hidden');
            }
        });
    }

    // Terms Modal Logic
    const termsBtn = document.getElementById('terms-btn');
    const termsModalOverlay = document.getElementById('terms-modal-overlay');
    const closeTermsBtn = document.getElementById('close-terms-btn');

    if (termsBtn && termsModalOverlay && closeTermsBtn) {
        termsBtn.addEventListener('click', () => {
            termsModalOverlay.classList.remove('hidden');
        });

        closeTermsBtn.addEventListener('click', () => {
            termsModalOverlay.classList.add('hidden');
        });

        // Click outside to close
        termsModalOverlay.addEventListener('click', (e) => {
            if (e.target === termsModalOverlay) {
                termsModalOverlay.classList.add('hidden');
            }
        });
    }

    // Tip Jar Modal Logic
    const tipBtn = document.getElementById('tip-btn');
    const tipModalOverlay = document.getElementById('tip-modal-overlay');
    const closeTipBtn = document.getElementById('close-tip-btn');

    if (tipBtn && tipModalOverlay && closeTipBtn) {
        tipBtn.addEventListener('click', () => {
            tipModalOverlay.classList.remove('hidden');
        });

        closeTipBtn.addEventListener('click', () => {
            tipModalOverlay.classList.add('hidden');
        });

        // Click outside to close
        tipModalOverlay.addEventListener('click', (e) => {
            if (e.target === tipModalOverlay) {
                tipModalOverlay.classList.add('hidden');
            }
        });
    }

    // Client Guide Modal Logic
    const clientGuideBtn = document.getElementById('client-guide-btn');
    const clientGuideModalOverlay = document.getElementById('client-guide-modal-overlay');
    const closeClientGuideBtn = document.getElementById('close-client-guide-btn');

    if (clientGuideBtn && clientGuideModalOverlay && closeClientGuideBtn) {
        clientGuideBtn.addEventListener('click', () => {
            clientGuideModalOverlay.classList.remove('hidden');
        });

        closeClientGuideBtn.addEventListener('click', () => {
            clientGuideModalOverlay.classList.add('hidden');
        });

        // Click outside to close
        clientGuideModalOverlay.addEventListener('click', (e) => {
            if (e.target === clientGuideModalOverlay) {
                clientGuideModalOverlay.classList.add('hidden');
            }
        });
    }

    startPolling();
});
