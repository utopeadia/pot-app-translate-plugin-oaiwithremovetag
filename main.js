async function translate(text, from, to, options) {
    // --- 1. Destructure Options & Get Config ---
    const { config, setResult, utils } = options; 
    const { http } = utils;
    // Check if http utils are available
    if (!http || !http.fetch || !http.Body || !http.ResponseType) {
       throw new Error("Required HTTP utilities are not available in this Pot version.");
    }
    const { fetch, Body, ResponseType } = http;

    // --- 2. Read and Validate Configuration ---
    const apiKey = config.apiKey;
    let requestPath = config.requestPath;
    const model = config.model || 'gpt-3.5-turbo';
    const systemPromptTemplate = config.system_prompt || 'You are a helpful translation assistant.';
    const userPromptTemplate = config.user_prompt || 'Translate the following text from $from to $to: $text';
    const parametersString = config.parameters || '{"temperature": 0.1}';
    const removeTagString = config.removeTag || '<think>,<help>';
    const useStream = config.use_stream === 'true';
    const languageMap = config.language || {};

    // Basic Validation
    if (!apiKey) {
        throw new Error('API Key is missing. Please configure it in the plugin settings.');
    }
    if (!requestPath) {
        throw new Error('Request Path (API Endpoint URL) is missing. Please configure it.');
    }

    // Ensure requestPath is a full URL pointing to /chat/completions
    if (!requestPath.startsWith('http://') && !requestPath.startsWith('https://')) {
        requestPath = `https://${requestPath}`;
    }
    if (!requestPath.endsWith('/chat/completions')) {
        if (requestPath.endsWith('/')) {
            requestPath += 'chat/completions';
        } else {
            requestPath += '/chat/completions';
        }
    }

    // Parse parameters JSON
    let parameters = { temperature: 0.1 };
    try {
        parameters = JSON.parse(parametersString);
    } catch (e) {
        console.warn('Failed to parse parameters JSON, using default. Error:', e);
    }

    // --- 3. Prepare Prompts and Messages ---
    const targetLang = languageMap[to] || to;
    const sourceLang = languageMap[from] || from;

    const systemPrompt = systemPromptTemplate
        .replace('$to', targetLang)
        .replace('$from', sourceLang)
        .replace('$text', text);
    const userPrompt = userPromptTemplate
        .replace('$text', text)
        .replace('$to', targetLang)
        .replace('$from', sourceLang);

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ];

    // --- 4. Define Tag Removal Helper ---
    const applyTagRemoval = (inputText) => {
        if (!removeTagString || !inputText) {
            return inputText;
        }
        let processedText = inputText;
        const tagsToRemove = removeTagString.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
        tagsToRemove.forEach(tag => {
            // More robust regex to handle tags like <tag>...</tag> or <tag/>
            // Escape potential regex characters in the tag itself if needed, but assuming simple tags like <think>
            const openingTag = tag.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'); // Escape regex metachars
            const closingTag = openingTag.replace('<', '</');
            const selfClosingTag = openingTag.replace('>', '/>');
            // Regex: <tag>content</tag> OR <tag/> (non-greedy)
            const regex = new RegExp(`${openingTag}(.*?)${closingTag}|${selfClosingTag}`, 'gs');
            processedText = processedText.replace(regex, '');
        });
        return processedText.trim();
    };

    // --- 5. Make API Request ---
    try {
        const response = await fetch(requestPath, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`
            },
            // Use Body.json to correctly serialize the body
            body: Body.json({
                model: model,
                messages: messages,
                stream: useStream,
                ...parameters // Merge custom parameters
            }),
            // Set response type based on whether streaming is enabled
            responseType: useStream ? ResponseType.Text : ResponseType.JSON
        });

        // Check for HTTP errors
        if (!response.ok) {
            // Try to parse error details from response body (might be JSON or text)
            let errorDetails = '';
            try {
                 // Try parsing as JSON first
                 const errorData = JSON.parse(response.data || '{}');
                 errorDetails = JSON.stringify(errorData.error || response.data);
            } catch (e) {
                 // If JSON parsing fails, use raw text
                 errorDetails = response.data || 'No additional error details available.';
            }
            throw new Error(`API Request Failed\nStatus: ${response.status}\nDetails: ${errorDetails}`);
        }

        // --- 6. Process Response ---

        // --- Non-Streaming ---
        if (!useStream) {
            const resultData = response.data; // Should be parsed JSON
            if (resultData && resultData.choices && resultData.choices.length > 0 && resultData.choices[0].message && resultData.choices[0].message.content) {
                const rawTranslatedText = resultData.choices[0].message.content.trim();
                const finalResult = applyTagRemoval(rawTranslatedText);
                if (setResult) setResult(finalResult); // Update UI once
                return finalResult;
            } else {
                throw new Error(`API Error: Invalid non-streaming response structure.\n${JSON.stringify(resultData)}`);
            }
        }

        // --- Streaming ---
        else {
            let accumulatedResult = "";
            const rawResponseText = response.data; // Should be raw text for SSE

            // Split the response into lines, typical for SSE
            const lines = rawResponseText.split(/(\r\n|\n|\r)/); // Split by newlines

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine) continue; // Skip empty lines

                // Check for the SSE 'data:' prefix
                if (trimmedLine.startsWith('data:')) {
                    const jsonData = trimmedLine.substring(5).trim(); // Remove 'data:' prefix

                    // Check for the end-of-stream signal
                    if (jsonData === '[DONE]') {
                        break; // Stop processing
                    }

                    try {
                        const parsedData = JSON.parse(jsonData);
                        // Extract content delta from the OpenAI streaming format
                        const delta = parsedData.choices?.[0]?.delta?.content;

                        if (delta) {
                            accumulatedResult += delta;
                            // Update the Pot UI incrementally
                            if (setResult) {
                                // Apply tag removal *before* setting the result for a cleaner stream
                                const intermediateResult = applyTagRemoval(accumulatedResult);
                                setResult(intermediateResult);
                                // Optional short delay to allow UI to update, adjust as needed
                                // await new Promise(resolve => setTimeout(resolve, 10));
                            }
                        }
                    } catch (e) {
                        console.error('Failed to parse JSON chunk:', jsonData, 'Error:', e);
                        // Continue to next line even if one chunk fails
                    }
                }
            }

            // Final processing and return for streaming
            const finalResult = applyTagRemoval(accumulatedResult);
            if (!finalResult && !accumulatedResult) { // Check if nothing was generated
                 // It's possible the stream ended without error but produced no content
                 console.warn("Stream finished, but no content was generated.");
                 // throw new Error("Stream finished, but no content was generated."); // Or return empty string
                 return ""; // Return empty string if nothing was generated
            }

            // Ensure the final result is set one last time
            if (setResult) {
                 setResult(finalResult);
                 await new Promise(resolve => setTimeout(resolve, 50)); // Small delay ensure final update renders
            }
            return finalResult; // Return the fully assembled and cleaned text
        }

    } catch (error) {
        // Catch fetch errors or errors thrown during processing
        console.error("Translation Plugin Error:", error);
        // Rethrow the error so Pot can display it
        throw error instanceof Error ? error : new Error(String(error));
    }
}