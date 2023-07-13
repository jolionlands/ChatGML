// show-codebase.js
(function () {
	var MenuItem = Electron_MenuItem;
	const { spawn } = require('child_process');
	const fs = require('fs');
	const path = require('path');
	const util = require('util');
	const { exec } = require('child_process');
	const os = require('os');
	var Preferences = $gmedit["ui.Preferences"];
	const execPromise = util.promisify(require('child_process').exec);

	let ready = false;
	let sizer, splitter, container, aiResponseEditor, session, mainCont, peekCommand;
	let userEditor;
	let gmlFile = null;
	let projectDirectory = null;
	let pythonProcess = null;
	let pythonOutputContent = "";
	let isChatGMLShown = false;  // Controls whether the ChatGML interface is visible/open
	var mainMenu;

	// File searching functionality
	let fileSearchButton;
	let selectedFiles = [];

	// Buttons
	let launchKillButton;
	let sendCommandButton;
	let regenerateButton;

	// Used to keep track of the last command to user accidentally sending duplicates
	let lastCommand = "";

	const cwd = process.cwd();
	console.log(`Current working directory: ${cwd}`);

	let repoPath = path.join(cwd, 'plugins', 'show-codebase', 'talk-codebase');
	let envPath = path.join(cwd, 'plugins', 'show-codebase', 'talk-venv');
	const requirementsPath = path.join(repoPath, 'requirements.txt');
	const userHomeDir = os.homedir();
	const configPath = path.join(userHomeDir, 'talk_codebase', 'talk_codebase_config.yaml');

	console.log(`Current repo path: ${repoPath}`);
	console.log(`Current requirements path: ${requirementsPath}`);
	console.log(`Current env path: ${envPath}`);

	// Global error handler
	process.on('uncaughtException', (err, origin) => {
		console.error('An uncaught error occurred!');
		console.error(`Origin: ${origin}`);
		console.error(err);
	});

	// Global unhandled promise rejection handler
	process.on('unhandledRejection', (reason, promise) => {
		console.error('Unhandled Rejection at:', promise, 'reason:', reason);
	});

	async function setupEnvironment() {
		try {
			// Check YAML file and run set_config if it does not exist
			const exists = fs.existsSync(configPath);

			if (!exists) {
				console.log("YAML config file does not exist. Creating one...");
				runPythonScript('set_config');
			} else {
				console.log("YAML config file already exists.");

				// Parse YAML file
				const config = parseYamlForPaths(configPath);

				// Update repoPath and envPath
				repoPath = config['repo_path'];
				envPath = config['venv_path'];
			}
		} catch (err) {
			console.error(`Error Getting info: ${err}`);
		}
	}

	async function loadConfig() {
		try {
			const configContent = await fs.promises.readFile(configPath, 'utf8');
			const configData = jsyaml.load(configContent);
			return configData;
		} catch (err) {
			console.error(`Error reading and parsing config file: ${err}`);
		}
	}
	
	function saveConfig(configData) {
		try {
			// Convert the configData object to a YAML string
			const configContent = jsyaml.dump(configData);
	
			// Write the contents to the YAML file
			fs.writeFile(configPath, configContent, 'utf8', (err) => {
				if (err) {
					console.error(`Error saving config file: ${err}`);
					return;
				}
				console.log('Config file saved successfully!');
			});
		} catch(err) {
			console.error(`Error dumping config object to YAML string: ${err}`);
		}
	}

	function sendToPython(input) {
		if (pythonProcess && pythonProcess.stdin) {
			pythonProcess.stdin.write(input + "\n");
		} else {
			console.error("Python process or stdin is not available.");
		}
	}

	function parseYamlForPaths(configPath) {
		// Read file line by line from end
		const lines = fs.readFileSync(configPath, 'utf-8').split('\n').reverse();
		const config = {};

		for (let line of lines) {
			if (line.trim() === '' || line.startsWith('#')) continue; // Ignore empty lines and comments

			let colonIndex = line.indexOf(':');
			let key = line.substring(0, colonIndex).trim();
			let value = line.substring(colonIndex + 1).trim();

			// If key is one of the paths, store it
			if (key === 'repo_path' || key === 'venv_path') {
				// Handle quoted strings and windows path
				if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
					value = value.slice(1, -1);
				}

				value = value.replace(/\\/g, '/');
				config[key] = value;
			}

			// If we have both values, we can break early
			if (config['repo_path'] && config['venv_path']) break;
		}

		return config;
	}


	function updateRepo(dirName) {
		// Full path for the directory
		const fullPath = path.join(process.cwd(), dirName);

		// Check if directory exists
		if (!fs.existsSync(fullPath)) {
			console.error(`Directory ${fullPath} does not exist. Clone the repo first.`);
			return;
		}

		// Navigate to the directory
		process.chdir(dirName);

		// Fetch and pull the latest code from the repo
		exec(`git pull`, (error, stdout, stderr) => {
			if (error) {
				console.error(`Error updating repo: ${error.message}`);
				return;
			}

			console.log(`Repo updated in ${fullPath}: ${stdout}`);
		});
	}

	function stdoutCallback(dataStr) {
        if (!dataStr) {
            return;
        }

        try {
            const dataObj = JSON.parse(dataStr);
            if (dataObj.ai_response) {
                const aiRespContent = dataObj.ai_response.trim();
                pythonOutputContent = aiRespContent;
                console.log('Received AI response for user query:\n', aiRespContent, dataObj);
                aiResponseEditor.setContent(pythonOutputContent);
                sendCommandButton.stopLoading();
                pythonOutputContent = "";
                return;
			} else if (dataObj.files) {
				const aiRespContent = dataObj.files;
                respFiles = aiRespContent;
                console.log('Found related files to user query:\n', aiRespContent, dataObj);
				displayFileSearchResults(respFiles);
                fileSearchButton.stopLoading();
                pythonOutputContent = "";
                return;
            } else {
                console.warn('Received unexpected data from Python script:\n', dataStr);
            }
        } catch(e) {
            if (e instanceof SyntaxError) {
                console.error("Failed to parse JSON from stdout:\n", dataStr);
            } else {
                throw e;
            }
        }
    }

    function stderrCallback(dataStr) {
        console.info('stderr data:', dataStr);
    }

	async function runPythonScript() {
		const pythonExecutable = process.platform === 'win32'
			? path.join(envPath, 'Scripts', 'python.exe')
			: path.join(envPath, 'bin', 'python3');
	
		const scriptPath = path.join(repoPath, 'talk_codebase', 'cli.py');
	
		// Check Python executable
		if (!fs.existsSync(pythonExecutable)) {
			console.error(`Python executable not found at: ${pythonExecutable}`);
			return null;
		} else {
			console.log(`Python executable found at: ${pythonExecutable}`);
		}
	
		// Check Python script
		if (!fs.existsSync(scriptPath)) {
			console.error(`Python script not found at: ${scriptPath}`);
			return null;
		} else {
			console.log(`Python script found at: ${scriptPath}`);
		}
	
		// Check for execution permissions on Unix
		if (process.platform !== "win32") {
			try {
				await fs.promises.access(pythonExecutable, fs.constants.X_OK);
			} catch (error) {
				console.error(`Python executable at: ${pythonExecutable} is not executable.`, error);
				return null;
			}
		}
	
		console.log("Running script in project directory", scriptPath, projectDirectory);
	
		// Spawn Python process
		try {
			pythonProcess = spawn(pythonExecutable, [scriptPath, 'chat', projectDirectory], {
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			console.log("Started Python process");
	
			return pythonProcess;
	
		} catch (err) {
			console.log("Caught error while trying to start python process", err);
			return null;
		}
	}

	function forceUpdate() {
		var e = new CustomEvent("resize");
		e.initEvent("resize");
		window.dispatchEvent(e);
	}

	function hide() {
		if (mainCont && sizer) {
			mainCont.removeChild(sizer);
		}
		if (mainCont && container) {
			mainCont.removeChild(container);
		}
		gmlFile = null;
		forceUpdate();
		setTimeout(() => aceEditor.focus());
	}

	function show(file) {
		if (!file.codeEditor) return;
		if (gmlFile == file) return;
		if (gmlFile == null) {
			if (ready) {
				mainCont.appendChild(sizer);
				mainCont.appendChild(container);
			} else prepare();
			forceUpdate();
		}
		gmlFile = file;
		session = GMEdit.aceTools.cloneSession(file.codeEditor.session);
		
		console.log(userEditor.kind);
	}

	function displayFileSearchResults(files) {
		// Clear previous search results
		selectedFiles = [];

		// Create a new container for all file elements
		var fileElementsContainer = document.createElement('div');
		fileElementsContainer.className = 'file-elements-container';
	
		// files should be an array of file paths
		files.forEach(file => {
			// Create a div to represent the file
			var fileElement = document.createElement('div');
			fileElement.className = 'file-element';
	
			// Use path.basename to get the file name from the full path
			fileElement.innerText = path.basename(file);
	
			// Add a button to deselect the file
			var deselectButton = document.createElement('button');
			deselectButton.innerText = "X";
			deselectButton.addEventListener('click', function() {
				fileElement.remove();
				var index = selectedFiles.indexOf(file);
				if (index > -1) {
					selectedFiles.splice(index, 1);
				}
			});
	
			fileElement.appendChild(deselectButton);
	
			// Add to the container
			fileElementsContainer.appendChild(fileElement);
	
			// Add to selected files
			selectedFiles.push(file);
		});

		// Add the new container to the main container
		container.appendChild(fileElementsContainer);
	}

	function prepare() {
		container = document.createElement("div");
		container.classList.add("ace_container");

		// Create a separate container for the buttons
		var buttonsContainer = document.createElement("div");
		buttonsContainer.classList.add("buttons-container");
		container.appendChild(buttonsContainer);

		// Create an editor for user's input/query
		userEditor = new CustomEditor(container);

		// Pick random example user input
		const exampleUserQuestions = [
			"Why is my game object not appearing on the screen?",
			"How can I optimize the performance of my game?",
			"What is the best way to manage collisions in my game?",
			"How can I make my character move smoothly across the screen?",
			"How do I implement a scoring system in my game?",
			"What's the most efficient way to manage memory in my game?",
			"How can I add multiplayer functionality to my game?",
			"How do I implement save game functionality?",
			"What's the best way to handle animation in my game?",
			"Why is my game running slowly when there are many objects on the screen?",
			"How can I create a pause menu in my game?",
			"Why is my game crashing after playing for a while?"
		];
		const randomIndex = Math.floor(Math.random() * exampleUserQuestions.length);
		const randomQuestion = exampleUserQuestions[randomIndex];
		userEditor.setContent(randomQuestion);

		// Launch/Kill Python process button
		launchKillButton = new PythonProcessButton(
			buttonsContainer, "Launch", "Kill", runPythonScript, "Launching...", stdoutCallback, stderrCallback, "Entered loop for queries..."
		);

		// Send Command button
		sendCommandButton = new PluginButtonLoadable(buttonsContainer, "Send Command", function() {
			var command = userEditor.content;
			// Check if the command is the same as the last one
			if (!userContent) {
				console.warn("User content is empty");
				return false;
			} else if (command !== lastCommand) {
				console.log("User content retrieved from editor", command);
				pythonProcess.stdin.write(command + "END\n");
				// Update the last command
				lastCommand = command;
				return true;
			} else {
				console.log("User attempted to send the same command again. Command not sent.");
				return false;
			}
		}, "Sending...");
		sendCommandButton.disable(); // Start with the button disabled until the Python process is launched

		// Listen for the stateChanged event on the launchKillButton and enable/disable dependent buttons accordingly
		launchKillButton.buttonElement.addEventListener('stateChanged', function(event) {
			if (event.detail === 'launched') {
				sendCommandButton.enable();
				regenerateButton.enable();
				fileSearchButton.enable();
			} else {
				sendCommandButton.disable();
				regenerateButton.disable();
				fileSearchButton.disable();
			}
		});

		// Regenerate button
		regenerateButton = new PluginButtonLoadable(buttonsContainer, "Regenerate", function() {
			sendToPython("RECREATE_VECTOR_STORE");
		}, "Regenerating...");
		regenerateButton.disable(); // Starts disabled - only enable after 'Launch' process is complete

		// File Search button
		fileSearchButton = new PluginButtonLoadable(buttonsContainer, "Find Files", function() {
			var userQuery = userEditor.content;
			if (!userQuery) {
				console.warn("User content is empty");
				return false;
			} else {
				sendToPython(userQuery + "FILE_SEARCH");
				return true;
			}
		}, "Searching...");
		fileSearchButton.disable();

		sizer = document.createElement("div");
		var editor_id = "codebase_editor";
		sizer.setAttribute("splitter-element", "#" + editor_id);
		sizer.setAttribute("splitter-lskey", "aside_width");
		sizer.setAttribute("splitter-default-width", "400");
		sizer.classList.add("splitter-td");

		var nextCont = document.createElement("div");
		nextCont.classList.add("ace_container");

		mainCont = aceEditor.container.parentElement;
		var mainChildren = [];
		for (var i = 0; i < mainCont.children.length; i++)
			mainChildren.push(mainCont.children[i]);
		for (var i = 0; i < mainChildren.length; i++) {
			var ch = mainChildren[i];
			mainCont.removeChild(ch);
			nextCont.appendChild(ch);
		}
		mainCont.style.setProperty("flex-direction", "row");
		mainCont.appendChild(nextCont);
		mainCont.appendChild(sizer);
		mainCont.appendChild(container);

		// Create an editor to display AI's response
		aiResponseEditor = new CustomEditor(container, true);

		container.id = editor_id;
		splitter = new GMEdit_Splitter(sizer);

		ready = true;
	}

	function updateMenuItems() {
		var showItem = mainMenu.getMenuItemById('show-codebase');
		var hideItem = mainMenu.getMenuItemById('hide-codebase');
		
		if (isChatGMLShown) {
			if (showItem) showItem.visible = false;
			if (hideItem) hideItem.visible = true;
		} else {
			if (showItem) showItem.visible = true;
			if (hideItem) hideItem.visible = false;
		}
	}	

	function init() {
		console.log(aceEditor.session)
		
		mainMenu = aceEditor.contextMenu.menu;
		var insertAt = 0;
		while (insertAt < mainMenu.items.length) {
			if (mainMenu.items[insertAt++].aceCommand == "selectall") break;
		}

		mainMenu.insert(insertAt, new MenuItem({type: "separator", id: "show-codebase-sep"}));
		mainMenu.insert(insertAt + 1, new MenuItem({
			label: "Show ChatGML",
			id: "show-codebase",
			icon: __dirname + "/icons/silk/application_split_vertical.png",
			click: function() {
				show(aceEditor.session.gmlFile);
				isChatGMLShown = true;
				updateMenuItems();
			}
		}));
		mainMenu.insert(insertAt + 2, new MenuItem({
			label: "Hide ChatGML",
			id: "hide-codebase",
			icon: __dirname + "/icons/silk/application_split_vertical.png",
			click: function() {
				hide();
				isChatGMLShown = false;
				updateMenuItems();
			}
		}));
		updateMenuItems();

		try {
			setupEnvironment("https://github.com/jolionlands/talk-codebase.git", "talk-codebase", "talk-venv", "cli.py");
		} catch (err) {
			console.error("Error during setupEnvironment:", err);
		}

		GMEdit.on("projectOpen", function (e) {
			console.log("Project opened: ", e.project);
			projectDirectory = e.project.dir
		});

		GMEdit.on("preferencesBuilt", function(e) {
			var out = e.target.querySelector('.plugin-settings[for="show-codebase"]');

			// Load YAML configuration
			loadConfig().then(config => {
				// Add each configuration field to the preferences
				for (let [key, value] of Object.entries(config)) {
					Preferences.addInput(out, key, value, function(text) {
						// Update YAML configuration when preference value changes
						config[key] = text;
						saveConfig(config);
					});
				}
			});
        });
	}

	GMEdit.register("show-codebase", {
		init: init,
		cleanup: function () {
			hide();
		},
	});

})();
