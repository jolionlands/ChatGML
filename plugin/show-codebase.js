// show-codebase.js
(function () {
	var MenuItem = Electron_MenuItem;
	const { spawn } = require('child_process');
	const fs = require('fs');
	const path = require('path');
	const util = require('util');
	const { exec } = require('child_process');
	const os = require('os');
	const Preferences = $gmedit["ui.Preferences"];
	const execPromise = util.promisify(require('child_process').exec);

	let ready = false;
	let sizer, splitter, container, editor, session, mainCont, peekCommand;
	let newEditor, newEditorContainer;
	let gmlFile = null;
	let projectDirectory = null;
	let pythonProcess = null;
	let pythonOutputContent = "";

	// Buttons
	let launchKillButton;
	let sendCommandButton;
	let openConfigButton;
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

	async function openConfigFile() {
		try {
			// Read the contents of the YAML file
			const data = await fs.promises.readFile(configPath, 'utf8');
	
			// Set the contents of the file to the Ace Editor
			newEditor.session.setValue(data);
		} catch (err) {
			console.error(`Error reading config file: ${err}`);
		}
	}

	function saveConfigFile() {
		// Get the contents of the Ace Editor
		const configContent = newEditor.session.getValue();

		// Write the contents to the YAML file
		fs.writeFile(configPath, configContent, 'utf8', (err) => {
			if (err) {
				console.error(`Error saving config file: ${err}`);
				return;
			}

			console.log('Config file saved successfully!');
		});
	}

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
                updateAceEditorContent(pythonOutputContent);
                sendCommandButton.stopLoading();
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

	// A function to update the content of Ace editor
	function updateAceEditorContent(content) {
		editor.session.setValue(content); // This will replace the current content in the Ace editor with the content variable
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
		console.log(editor)
		console.log(gmlFile)
		console.log(session)
		session = GMEdit.aceTools.cloneSession(file.codeEditor.session);
		// var session2 = GMEdit.aceTools.cloneSession(file.codeEditor.session);
		editor.session.setMode("ace/mode/javascript"); // Set the language mode
		newEditor.session.setMode("ace/mode/javascript");
		console.log(newEditor.kind)
	}

	function prepare() {
		ready = true;
		container = document.createElement("div");
		container.classList.add("ace_container");

		// Create a separate container for the buttons
		var buttonsContainer = document.createElement("div");
		buttonsContainer.classList.add("buttons-container");
		container.appendChild(buttonsContainer);
		newEditorContainer = document.createElement('div');
		newEditorContainer.id = 'newEditorContainer';
		container.appendChild(newEditorContainer);

		newEditor = GMEdit.aceTools.createEditor(newEditorContainer);
		//newEditor.setTheme("ace/theme/monokai"); // Set the theme
		newEditor.session.setMode("ace/mode/javascript"); // Set the language mode
		newEditor = editor;
		newEditor = ace.edit(newEditorContainer);

		// Toggle Launch/Kill button
		launchKillButton = new PythonProcessButton(
			buttonsContainer, "Launch", "Kill", runPythonScript, "Launching...", stdoutCallback, stderrCallback, "Entered loop for queries..."

		);

		// Send Command button
		sendCommandButton = new PluginButtonLoadable(buttonsContainer, "Send Command", function() {
			return new Promise((resolve, reject) => {
				var command = ace.edit(newEditorContainer).getValue();
				// Check if the command is the same as the last one
				if (!command) {
					console.warn("User content is empty");
					reject("User content is empty");
				} else if (command !== lastCommand) {
					console.log("User content retrieved from editor", command);
					pythonProcess.stdin.write(command + "END\n");
					// Update the last command
					lastCommand = command;
					resolve();
				} else {
					console.log("User attempted to send the same command again. Command not sent.");
					reject("User attempted to send the same command again. Command not sent.");
				}
			});
		}, "Sending...");

		// Open Config button
		openConfigButton = new PluginButton(buttonsContainer, "Open Config", function() {
			openConfigFile();

			// Create the "Save" button
			var saveButton = new PluginButton(buttonsContainer, "Save", function() {
				var configContent = newEditor.session.getValue();
				saveConfigFile();
				console.log("Saving config:", configContent);
			});

			// Create the "Exit" button
			var exitButton = new PluginButton(buttonsContainer, "Exit", function() {
				// Remove the editor and buttons from the container
				newEditor.session.setValue("");
				saveButton.remove();
				exitButton.remove();
			});
		});

		// Regenerate button
		regenerateButton = new PluginButtonLoadable(buttonsContainer, "Regenerate", function() {
			sendToPython("RECREATE_VECTOR_STORE");
		}, "Regenerating...");
		regenerateButton.disable(); // Starts disabled - only enable after 'Launch' process is complete

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

		var textarea = document.createElement("textarea");
		container.appendChild(textarea);
		editor = GMEdit.aceTools.createEditor(textarea);

		container.id = editor_id;
		splitter = new GMEdit_Splitter(sizer);

		var sideMenu = editor.contextMenu.menu;
		var insertAt = 0;
		while (insertAt < sideMenu.items.length) {
			if (sideMenu.items[insertAt++].aceCommand == "selectall") break;
		}
		sideMenu.insert(insertAt, new MenuItem({ type: "separator" }));
		sideMenu.insert(insertAt + 1, new MenuItem({
			label: "Hide aside",
			click: function () {
				hide();
			}
		}));

		var sideMenu = newEditor.contextMenu.menu;
		var insertAt = 0;
		while (insertAt < sideMenu.items.length) {
			if (sideMenu.items[insertAt++].aceCommand == "selectall") break;
		}
		sideMenu.insert(insertAt, new MenuItem({ type: "separator" }));
		sideMenu.insert(insertAt + 1, new MenuItem({
			label: "Hide aside",
			click: function () {
				hide();
			}
		}));

	}

	function init() {
		console.log(aceEditor.session)
		var mainMenu = aceEditor.contextMenu.menu;
		var insertAt = 0;
		while (insertAt < mainMenu.items.length) {
			if (mainMenu.items[insertAt++].aceCommand == "selectall") break;
		}
		console.log("mainmenu lenght = " + mainMenu.items.length)
		console.log("inser at  = " + insertAt + 2,)
		var insertPosition = Math.min(insertAt + 2, mainMenu.items.length);

		mainMenu.insert(insertPosition, new MenuItem({
			label: "Show codebase",
			id: "show-codebase",
			icon: __dirname + "/icons/silk/application_split_vertical.png",
			click: function () {
				show(aceEditor.session.gmlFile);
			}
		}));

		try {
			setupEnvironment("https://github.com/jolionlands/talk-codebase.git", "talk-codebase", "talk-venv", "cli.py");
		} catch (err) {
			console.error("Error during setupEnvironment:", err);
		}

		GMEdit.on("projectOpen", function (e) {
			console.log("Project opened: ", e.project);
			projectDirectory = e.project.dir
		});

	}

	GMEdit.register("show-codebase", {
		init: init,
		cleanup: function () {
			hide();
		},
	});

})();
