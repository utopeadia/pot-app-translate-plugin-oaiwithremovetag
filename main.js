import { Body } from '@tauri-apps/api/http'; 

async function translate(text, from, to, options) {
    const { config, utils, setResult, detect } = options;
    const { tauriFetch } = utils;

    const apiKey = config.apiKey;
    let requestPath = config.requestPath;
    const model = config.model || 'gpt-4o-mini';
    const systemPromptTemplate = config.system_prompt || 'You are a helpful translation assistant.';
    const userPromptTemplate = config.user_prompt || 'Translate the following text from $from to $to: $text';
    const parametersString = config.parameters || '{"temperature": 0.1}';
    const removeTagString = config.removeTag || '<think>,<help>';
    const useStream = config.use_stream === 'true';
    const languageMap = config.language || {};

    if (!apiKey) {
        throw 'API Key is missing. Please configure it in the plugin settings.';
    }
    if (!requestPath) {
        throw 'Request Path (API Endpoint URL) is missing. Please configure it.';
    }

    if (!requestPath.startsWith('http://') && !requestPath.startsWith('https://')) {
        requestPath = `https://${requestPath}`;
    }
    const apiUrl = new URL(requestPath);
    if (!apiUrl.pathname.endsWith('/chat/completions')) {
       if (!apiUrl.pathname.endsWith('/')) {
            apiUrl.pathname += '/';
       }
       apiUrl.pathname += 'chat/completions';
    }


    const targetLang = languageMap[to] || to;
    const sourceLang = languageMap[from] || from;
    const detectedLang = languageMap[detect] || detect;

    const systemPrompt = systemPromptTemplate
        .replace('$to', targetLang)
        .replace('$from', sourceLang)
        .replace('$detect', detectedLang);
    const userPrompt = userPromptTemplate
        .replace('$text', text)
        .replace('$to', targetLang)
        .replace('$from', sourceLang)
        .replace('$detect', detectedLang);

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ];

    let parameters = { "temperature":0.6,"top_p":0.99,"frequency_penalty":0,"presence_penalty":0 };
    try {
        parameters = JSON.parse(parametersString);
    } catch (e) {
        console.warn('Failed to parse parameters JSON, using default. Error:', e);
    }

    const requestBody = {
        model: model,
        messages: messages,
        ...parameters,
        stream: useStream && setResult != null
    };

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
    };

    const applyRemoveTag = (inputText) => {
         if (!inputText) return inputText;
         let processedText = inputText;
         if (removeTagString) {
            const tagsToRemove = removeTagString.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
            tagsToRemove.forEach(tag => {
                const escapedTag = tag.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                const regex = new RegExp(`${escapedTag}(?:\\s*\\/>|>(.*?)<\\/${escapedTag.substring(1)}>)`, 'gs');
                processedText = processedText.replace(regex, '');
            });
         }
         return processedText.trim();
    };


    if (useStream && setResult) {
        try {
            const response = await window.fetch(apiUrl.href, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                let errorBody = await response.text();
                try { errorBody = JSON.parse(errorBody); } catch { /* ignore if not json */ }
                throw `API Request Failed\nStatus: ${response.status}\nDetails: ${JSON.stringify(errorBody, null, 2)}`;
            }

            if (!response.body) {
                throw 'Response body is null, cannot process stream.';
            }

            let fullContent = '';
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let chunkBuffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break; 
                }

                chunkBuffer += decoder.decode(value, { stream: true });
                const lines = chunkBuffer.split('\n');

                chunkBuffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataContent = line.substring(6).trim();
                        if (dataContent === '[DONE]') {
                        } else {
                            try {
                                const parsed = JSON.parse(dataContent);
                                if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content) {
                                    const deltaContent = parsed.choices[0].delta.content;
                                    fullContent += deltaContent;
                                    setResult(applyRemoveTag(fullContent) + '...');
                                }
                            } catch (e) {
                                console.error("Error parsing stream data JSON:", e, "Data:", dataContent);
                            }
                        }
                    }
                }
            }
            reader.releaseLock();
            const finalResult = applyRemoveTag(fullContent);
            setResult(finalResult);
            return finalResult;

        } catch (error) {
            console.error("Streaming Fetch Error:", error);
            throw `Streaming Error: ${error.message || error}`;
        }

    } else {
        let res;
        try {
            res = await tauriFetch(apiUrl.href, { 
                method: 'POST',
                headers: headers,
                body: Body.json(requestBody),
                responseType: 2,
                timeout: 30
            });
        } catch (error) {
            throw `Network or Fetch Error: ${error.message || error}`;
        }

        if (res.ok) {
            const resultData = res.data;
            if (resultData && resultData.choices && resultData.choices.length > 0 && resultData.choices[0].message && resultData.choices[0].message.content) {
                let translatedText = resultData.choices[0].message.content.trim();
                return applyRemoveTag(translatedText);
            } else {
                throw `API Error: Invalid response structure received.\n${JSON.stringify(resultData)}`;
            }
        } else {
            let errorDetails = JSON.stringify(res.data);
            throw `API Request Failed\nStatus: ${res.status}\nDetails: ${errorDetails}`;
        }
    }
}