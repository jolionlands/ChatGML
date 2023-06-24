(function() {
	var MenuItem = Electron_MenuItem;
	var { spawn } = require('child_process');
	var ready = false;
	var sizer, splitter, container, editor, session, mainCont, peekCommand;
	var newEditor, newEditorContainer;
	var gmlFile = null;
	var Preferences = $gmedit["ui.Preferences"];
	const fs = require('fs');
	const path = require('path');
	const util = require('util');
	const { exec } = require('child_process');
	const execPromise = util.promisify(require('child_process').exec);
	const os = require('os');
	var projectDirectory = null
	var pythonProcess;  // declare at global scope
	var pythonOutputContent = ""; // Initialize an empty string to hold the Python script's output
	// Set repoPath to the plugins folder in the APPDATA directory
	const cwd = process.cwd();
	console.log("this is the current working directory"+process.cwd())
	// Set repoPath to the plugins folder in the current directory
	const repoPath = path.join(cwd, 'plugins','show-codebase','talk-codebase');
	// Set envPath to the virtual environment folder in the current directory
	const envPath  = path.join(cwd, 'plugins','show-codebase','talk-venv');
	// Your Python executable path should also change accordingly
	const pythonExecutable = path.join(envPath, 'Scripts', 'python.exe');
	const requirementsPath = path.join(repoPath,'requirements.txt');
	const configPath = path.join(os.homedir(), 'talk_codebase', 'talk_codebase_config.yaml');
	//console.log(requirementsPath)
	console.log("this is the current repo path denvPathirectory"+repoPath)
	console.log("this is the current requirements path directory"+requirementsPath)
	console.log("this is the current env path directory"+envPath)
	//console.log(process.cwd())
	const userHomeDir = os.homedir();
	
	function openConfigFile() {
		// Read the contents of the YAML file
		fs.readFile(configPath, 'utf8', (err, data) => {
		  if (err) {
			console.error(`Error reading config file: ${err}`);
			return;
		  }
	  
		  // Set the contents of the file to the Ace Editor
		  newEditor.session.setValue(data);
		});
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
	// Function to check if the YAML config file exists
	function checkYAMLFileExists() {
		fs.access(configPath, fs.constants.F_OK, (err) => {
			if (err) {
				console.log("YAML config file does not exist. Creating one...");
				runPythonScript('set_config');
			} else {
				console.log("YAML config file already exists.");
			}
		});
	}

	async function setupEnvironment() {
		try {		
			// Check YAML file and run set_config if it does not exist
			checkYAMLFileExists();
		  
		} catch(err) {
			console.error(`Error Getting info: ${err}`);
		}
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
	async function runPythonScript(input) {
		
		const scriptPath = path.join(repoPath, 'talk_codebase', 'cli.py');
		const pythonExecutable = process.platform === 'win32'
			? path.join(envPath, 'Scripts', 'python.exe')
			: path.join(envPath, 'bin', 'python');
	  
		// Check Python executable
		if (!fs.existsSync(pythonExecutable)) {
			console.error(`Python executable not found at: ${pythonExecutable}`);
			return;
		} else {
			console.log(`Python executable found at: ${pythonExecutable}`);
		}
	  
		// Check Python script
		if (!fs.existsSync(scriptPath)) {
			console.error(`Python script not found at: ${scriptPath}`);
			return;
		} else {
			console.log(`Python script found at: ${scriptPath}`);
		}
	  
		console.log(`Running script at: ${scriptPath}`);
		try {
				pythonProcess = spawn(pythonExecutable, [scriptPath,'chat',projectDirectory], {
				stdio: ['pipe', 'pipe', process.stderr], // Redirect stdout and stderr to pipes
			});
	  
			pythonProcess.on('error', (error) => {
				console.error('Failed to start subprocess.', error);
			});
			
			// Listen for data events on stdout
			pythonProcess.stdout.on('data', (data) => {
				
				const dataStr = data.toString();
				//console.log('Python script output:', dataStr);
			
				if (dataStr.includes('EOF')) {
					console.log('Python script finished outputting.');
					updateAceEditorContent(pythonOutputContent); // Update Ace editor content when the Python process finishes outputting
					pythonOutputContent="";
				} else {
					pythonOutputContent += dataStr; // Append output to pythonOutputContent
				}
				let apple = dataStr
				if (apple.trim() == ('SET UP')) {
					console.log('Python script setting up outputting. Y');
					pythonProcess.stdin.write('Y' + "\n");
				}
			});
	  
			// Listen for data events on stderr (optional)
			pythonProcess.stderr.on('data', (data) => {
				console.error('Python script error:', data.toString());
			});
			pythonProcess.stdout.on('end', () => {
				console.log('Python script finished outputting.');
				updateAceEditorContent(pythonOutputContent); // Update Ace editor content when the Python process finishes outputting
			});
	  
			// Handle the close event
			pythonProcess.on('close', (code) => {
				console.log('Python script exited with code:', code);
			});
		} catch (err) {
			
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
		mainCont.removeChild(sizer);
		mainCont.removeChild(container);
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
		var session2 = GMEdit.aceTools.cloneSession(file.codeEditor.session);
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

		var pythonButton = document.createElement("button");
		pythonButton.textContent = "Launch talk-codebase";
		pythonButton.classList.add("run-button");
		pythonButton.addEventListener("click", function() {
		var input = "START";
		runPythonScript(input);
		});
		buttonsContainer.appendChild(pythonButton);

		var sendCommandButton = document.createElement("button");
		sendCommandButton.textContent = "Send Command";
		sendCommandButton.classList.add("run-button");
		sendCommandButton.addEventListener("click", function() {
		var command = ace.edit(newEditorContainer).getValue();
			console.log(command);
			console.log(pythonProcess)
			pythonProcess.stdin.write(command + "\n"); // Write to the Python process' stdin
		});
		buttonsContainer.appendChild(sendCommandButton);

		var killButton = document.createElement("button");
		killButton.textContent = "Kill";
		killButton.classList.add("run-button");
		killButton.addEventListener("click", function() {
		if (pythonProcess) {
			pythonProcess.kill(); // Kill the Python process
			pythonProcess = null; // Set the pythonProcess variable to null
			console.log("Python process killed.");
		}
		});
		buttonsContainer.appendChild(killButton);

				// Create the "Open Config" button
		var openConfigButton = document.createElement("button");
		openConfigButton.textContent = "Open Config";
		openConfigButton.classList.add("run-button");
		openConfigButton.addEventListener("click", function() {
			openConfigFile();

			// Create the "Save" button
			var saveButton = document.createElement("button");
			saveButton.textContent = "Save";
			saveButton.classList.add("run-button");
			saveButton.addEventListener("click", function() {
				var configContent = newEditor.session.getValue();
				// Replace this with the logic to save the config YAML file
				console.log("Saving config:", configContent);
			});
			buttonsContainer.appendChild(saveButton);

			// Create the "Exit" button
			var exitButton = document.createElement("button");
			exitButton.textContent = "Exit";
			exitButton.classList.add("run-button");
			exitButton.addEventListener("click", function() {
				// Remove the editor and buttons from the container
				newEditor.session.setValue("");
				buttonsContainer.removeChild(saveButton);
				buttonsContainer.removeChild(exitButton);
			});
			buttonsContainer.appendChild(exitButton);
		});
		buttonsContainer.appendChild(openConfigButton);
		
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
		  click: function() {
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
			click: function() {
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
		console.log("mainmenu lenght = "+mainMenu.items.length)
		console.log("inser at  = "+insertAt + 2,)
		var insertPosition = Math.min(insertAt + 2, mainMenu.items.length);

		mainMenu.insert(insertPosition, new MenuItem({
			label: "Show codebase",
			id: "show-codebase",
			icon: __dirname + "/icons/silk/application_split_vertical.png",
			click: function() {
				show(aceEditor.session.gmlFile);
			}
		}));
		setupEnvironment("https://github.com/jolionlands/talk-codebase.git", "talk-codebase", "talk-venv","cli.py");

		GMEdit.on("projectOpen", function(e) {
			console.log("Project opened: ", e.project);
			projectDirectory = e.project.dir
		  });
		
	}

	GMEdit.register("show-codebase", {
		init: init,
		cleanup: function() {
			hide();
		},
	});

})();
