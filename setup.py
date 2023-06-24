import os
import shutil
import subprocess
import platform
import yaml
import consts
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(PROJECT_ROOT, 'talk-venv')


def determine_plugin_location():
    if platform.system() == 'Windows':
        return os.path.join(os.getenv('APPDATA'), 'AceGM', 'GMEdit', 'plugins')
    elif platform.system() == 'Darwin':
        return os.path.join(os.path.expanduser('~'), 'Library', 'Application Support', 'AceGM', 'GMEdit', 'plugins')
    else:
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
        subprocess.run(["python3", "-m", "venv", env_path], shell=True)

def install_requirements(env_path, requirements_path):
    activate_path = os.path.join(env_path, "bin", "activate") if platform.system() != "Windows" else os.path.join(env_path, "Scripts", "activate.bat")
    if platform.system() == "Windows":
        subprocess.run(["cmd.exe", "/c", activate_path, "&&", "pip", "install", "-r", requirements_path], shell=True)
    else:
        subprocess.run(["/bin/bash", "-c", f"source {activate_path} && pip install -r {requirements_path}"], shell=True)

def exclude_from_git(file_path):
    with open('.gitignore', 'a') as gitignore:
        gitignore.write(f'\n{file_path}')

def update_yaml(config_path):
    # Get the current working directory
    repo_path = os.getcwd()

    # Assume a 'talk-venv' folder in the same directory as the virtual environment
    env_path = os.path.join(repo_path, 'talk-venv')

    # Get the default configuration and update it with the repo_path and venv_path
    data = consts.DEFAULT_CONFIG.copy()
    data.update({
        'repo_path': repo_path,
        'venv_path': env_path
    })

    # Check if the yaml file already exists
    if os.path.exists(config_path):
        # If it exists, load the current data
        with open(config_path, 'r') as infile:
            current_data = yaml.safe_load(infile)
            # Update the current data with the new data
            current_data.update(data)
        data = current_data

    # Write the data to the yaml file
    with open(config_path, 'w') as outfile:
        yaml.dump(data, outfile, default_flow_style=False)
def setup():
    # Create and activate virtual environment
    if not os.path.exists(ENV_PATH):
        create_virtual_environment(ENV_PATH)

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
