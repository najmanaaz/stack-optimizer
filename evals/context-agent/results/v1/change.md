AWS deployment: Bedrock Knowledge Base retrieval (vector search, user_id filter) + Claude Haiku 4.5 on Bedrock

Same 32 questions, same fixture files (loaded into the Knowledge Base as an eval tenant by aws-fixtures.py) and the same claude-sonnet-5-5 judge as baseline. Baseline is the www deployment: BM25 search over the files in memory + claude-haiku-5-5 on the Claude API. Both use the same Context Agent system prompt and top-8 retrieval, so differences come from the search method and the model.
