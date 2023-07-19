# ChatGML
* ChatGML is a plugin for [GMEdit](https://github.com/YellowAfterlife/GMEdit) to ask questions to and converse with your [GameMaker](https://gamemaker.io/en) game's codebase using LLMs (Large Language Models).
* It supports offline code processing using [GPT4All](https://github.com/nomic-ai/gpt4all) without sharing your code with third parties and OpenAI's ChatGPT.
* ChatGML is still under development, but it is a tool that can help you to improve your code. It is only recommended for educational purposes and not for production use.

## Installation Requirements
* Python 3.9
* An OpenAI API [api-keys](https://platform.openai.com/account/api-keys)
* (Optional) [GPT4All](https://gpt4all.io) 

## Installation Guide
* TODO

## Advanced configuration

You can also edit the configuration manually by editing the `~/.config.yaml` file.
If for some reason you cannot find the configuration file, just run the tool and at the very beginning it will output
the path to the configuration file.

```yaml
# The OpenAI API key. You can get it from https://beta.openai.com/account/api-keys
api_key: sk-xxx

# Configuration for chunking
chunk_overlap: 50
chunk_size: 500

# Configuration for sampling
k: 4  # Essentially how many relevant files/sections to send to the AI for context
max_tokens: 1048

# Configuration for the LLM model
model_name: gpt-3.5-turbo
model_path: models/ggml-gpt4all-j-v1.3-groovy.bin
model_type: openai
```

## Get the project structure (Unix)
```
find . | grep -v "__pycache__\|\.pytest_cache\|\.benchmarks\|ffmpeg\|\.pyc\|./talk-venv\|./.github\|./.DS_Store\|./.git" > project_structure.txt
```

## Other Resources
* TODO

## Contributing

* If you find a bug in ChatGML, please report it on the project's issue tracker. When reporting a bug, please include as much information as possible, such as the steps to reproduce the bug, the expected behavior, and the actual behavior.
* If you have an idea for a new feature for Talk-codebase, please open an issue on the project's issue tracker. When suggesting a feature, please include a brief description of the feature, as well as any rationale for why the feature would be useful.
* You can contribute to talk-codebase by writing code. The project is always looking for help with improving the codebase, adding new features, and fixing bugs.
