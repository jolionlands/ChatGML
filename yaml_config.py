MODEL_TYPES = {
    "OPENAI": "openai",
    "LOCAL": "local",
}
DEFAULT_CONFIG = {
    "api_key":None,
    "max_tokens": "16000",
    "chunk_size": "2056",
    "chunk_overlap": "256",
    "k": "1",
    "model_name": "gpt-3.5-turbo-16k-0613",
    "model_path": "models/ggml-gpt4all-j-v1.3-groovy.bin",
    "model_type": MODEL_TYPES["OPENAI"],
    "repo_path":None,
    "venv_path":None

}
