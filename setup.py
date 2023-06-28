import os
import shutil
import subprocess
import platform
import yaml
import yaml_config
import json
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(PROJECT_ROOT, 'talk-venv')



def determine_plugin_location():
    os_name = platform.system()
    config_path=os.path.join(PROJECT_ROOT,'config.yaml')

    # Load the configuration
    with open(config_path, 'r') as f:
        config = yaml.safe_load(f)

    # Check if a plugin location is specified in the config file
    if "plugin_locations" in config and config["plugin_locations"][os_name] is not None:
        plugin_location = os.path.expanduser(os.path.expandvars(config["plugin_locations"][os_name]))
        if os.path.isdir(plugin_location):
            return plugin_location

    # If no valid path was found in the config file, look in the Linux directory
    if os_name == 'Linux':
        home_dir = os.path.expanduser('~')
        gmedit_dir = os.path.join(home_dir, 'Documents', 'GMEdit')
        plugins_dir = os.path.join(gmedit_dir, 'resources', 'app', 'plugins', 'show-codebase')

        if os.path.isdir(gmedit_dir):
            return plugins_dir

    return None

def copy_files_to_plugin_directory(src_directory, dest_directory):
    if not os.path.exists(src_directory):
        print(f"Source directory does not exist: {src_directory}")
        return

    if not os.path.exists(dest_directory):
        os.makedirs(dest_directory)

    for filename in os.listdir(src_directory):
        src_file_path = os.path.join(src_directory, filename)
        dest_file_path = os.path.join(dest_directory, filename)

        if os.path.isfile(src_file_path):
            shutil.copy2(src_file_path, dest_file_path)

def update_plugin(plugin_files_source):
    plugin_location = determine_plugin_location()
    if plugin_location is not None:
        copy_files_to_plugin_directory(plugin_files_source, plugin_location)

def create_virtual_environment(env_path):
    if platform.system() == "Windows":
        subprocess.run(["python", "-m", "venv", env_path], shell=True)
    else:
        subprocess.run(["python3", "-m", "venv", env_path])

def install_requirements(env_path, requirements_path):
    activate_path = os.path.join(env_path, "bin", "activate") if platform.system() != "Windows" else os.path.join(env_path, "Scripts", "activate")

    # Differentiate between Windows and Unix-based systems
    if platform.system() == "Windows":
        command = f"{activate_path} && pip install -r {requirements_path}"
        process = subprocess.Popen(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    else:
        command = f"source {activate_path} && pip install -r {requirements_path}"
        process = subprocess.Popen(['/bin/bash', '-c', command], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    # Capture output and errors
    stdout, stderr = process.communicate()

    # Print output and errors
    if stdout:
        print(f"OUTPUT:\n{stdout.decode()}")
    if stderr:
        print(f"ERROR:\n{stderr.decode()}")

def exclude_from_git(file_path):
    relative_path = os.path.relpath(file_path, PROJECT_ROOT)
    
    ignore_entry = f'\n{relative_path}'
    
    # Determine the base directory from the provided file_path
    base_dir = os.path.dirname(file_path)
    gitignore_path = os.path.join(base_dir, '.gitignore')
    
    # Read the current .gitignore file
    with open(gitignore_path, 'r') as gitignore:
        if ignore_entry in gitignore.read():
            print(f"'{file_path}' is already in .gitignore")
            return

    # Append the file_path to the .gitignore file
    with open(gitignore_path, 'a') as gitignore:
        gitignore.write(ignore_entry)

def update_yaml(config_path, default_config_path= os.path.join(PROJECT_ROOT,'config.yaml')):
    # Check if the directory of config_path exists, if not, create it
    config_dir = os.path.dirname(config_path)
    if not os.path.exists(config_dir):
        os.makedirs(config_dir)

    # Load the default configuration from the yaml file
    with open(default_config_path, 'r') as default_config_file:
        default_data = yaml.safe_load(default_config_file)
    #print(default_data)
    # Get the current working directory
    repo_path = PROJECT_ROOT
    data = default_data.get('PLUGIN_CONFIG', {})
    # Assume a 'talk-venv' folder in the same directory as the virtual environment
    # Get the current working directory
    repo_path = PROJECT_ROOT

    # Assume a 'talk-venv' folder in the same directory as the virtual environment
    env_path = os.path.join(repo_path, 'talk-venv')

    # Update data with the repo_path and venv_path
    data.update({
        'repo_path': repo_path,
        'venv_path': env_path
    })

     # If the yaml file already exists and contains data, load it
    if os.path.exists(config_path) and os.path.getsize(config_path) > 0:
        with open(config_path, 'r') as infile:
            current_data = yaml.safe_load(infile)
            print(current_data)
            # Update the 'repo_path' and 'venv_path' in current_data with the values from data
            current_data['repo_path'] = data['repo_path']
            current_data['venv_path'] = data['venv_path']

    else:
        current_data = data
    # Write the data to the yaml file
    with open(config_path, 'w') as outfile:
        yaml.dump(current_data, outfile, default_flow_style=False)


def setup():
    print("running")
    # Create and activate virtual environment
    if not os.path.exists(ENV_PATH):
        create_virtual_environment(ENV_PATH)
        # Exclude virtual environment from git
    exclude_from_git(ENV_PATH)
    # Install requirements in the created environment
    requirements_path = os.path.join(PROJECT_ROOT, 'requirements.txt')
    if os.path.exists(requirements_path):
        install_requirements(ENV_PATH, requirements_path)

    # Exclude virtual environment from git
    exclude_from_git(ENV_PATH)

    # Update plugin files
    update_plugin(os.path.join(PROJECT_ROOT, 'plugin'))

    # Update the configuration yaml file
    config_path = os.path.join(os.path.expanduser("~"), "talk_codebase", "talk_codebase_config.yaml")
    update_yaml(config_path)

if __name__ == "__main__":
    setup()
