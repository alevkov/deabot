import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import * as dotenv from 'dotenv';
import input from 'input';
import axios from 'axios';
import { promises as fs } from 'fs';
dotenv.config();
const { TG_API_ID, TG_API_HASH, PHONE_NUMBER, SESSION_NAME, } = process.env;
const MY_USERNAME = 'dea_hq';
(async () => {
    const candlecontext = await fs.readFile('/Users/sernyl/dev/tg-sb/src/candle.txt', 'utf8');
    console.log(candlecontext);
    const COMMANDS = {
        q: {
            prefix: '!q',
            endpoint: 'http://localhost:8000/q',
            params: {
                temperature: 0.3,
                tokens: 3000,
                model: 'openai-next',
                version: 'v2',
            },
        },
        b: {
            prefix: '!cb',
            endpoint: 'http://localhost:8000/q',
            params: {
                "temperature": 0.92,
                "tokens": 4000,
                "format": "fun",
                "model": "openai-next",
                "version": "v2",
            },
        },
    };
    const stringSession = new StringSession(SESSION_NAME);
    const client = new TelegramClient(stringSession, parseInt(TG_API_ID, 10), TG_API_HASH, { connectionRetries: 5 });
    const messagesMap = {};
    const entityCache = {};
    async function login() {
        console.log('Starting login process...');
        let attempts = 0;
        const maxAttempts = 3;
        while (attempts < maxAttempts) {
            try {
                console.log(`Attempt ${attempts + 1} of ${maxAttempts}`);
                await client.start({
                    phoneNumber: async () => PHONE_NUMBER,
                    password: async () => await input.text('Please enter your 2FA password: '),
                    phoneCode: async () => await input.text('Please enter the code you received: '),
                    onError: (err) => console.log(err),
                });
                console.log('Login successful!');
                return true;
            }
            catch (error) {
                console.log(`Error during login: ${error.message}`);
                if (error.message.includes('PHONE_CODE_INVALID')) {
                    console.log('Invalid phone code. Please try again.');
                    attempts++;
                }
                else if (error.message.includes('FLOOD_WAIT_')) {
                    const waitTime = parseInt(error.message.split('_')[2]);
                    console.log(`FloodWaitError: Need to wait ${waitTime} seconds before trying again.`);
                    await new Promise((resolve) => setTimeout(resolve, waitTime * 1000));
                }
                else {
                    throw error;
                }
            }
        }
        console.log('Max login attempts reached. Please try again later.');
        return false;
    }
    async function sendPromptAndGetResponse(command, question, context = '') {
        const { endpoint, params } = COMMANDS[command];
        try {
            const response = await axios.post(endpoint, {
                question,
                context: candlecontext,
                ...params,
            }, {
                headers: { 'Content-Type': 'application/json' },
            });
            return response.data.assistant;
        }
        catch (error) {
            console.error(`Error sending prompt to ${endpoint}:`, error);
            return 'Sorry, I encountered an error while processing your request.';
        }
    }
    function parseCommand(text) {
        for (const [key, value] of Object.entries(COMMANDS)) {
            if (text.startsWith(value.prefix)) {
                return {
                    command: key,
                    content: text.slice(value.prefix.length).trim(),
                };
            }
        }
        return null;
    }
    async function handleNewMessage(event) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const msg = event.message;
        let messageType = 'unknown';
        let entityId;
        if ((_a = msg === null || msg === void 0 ? void 0 : msg.peerId) === null || _a === void 0 ? void 0 : _a.chatId) {
            messageType = 'group';
            entityId = msg.peerId.chatId;
        }
        else if ((_b = msg === null || msg === void 0 ? void 0 : msg.peerId) === null || _b === void 0 ? void 0 : _b.channelId) {
            messageType = 'channel';
            entityId = msg.peerId.channelId;
        }
        else if ((_c = msg === null || msg === void 0 ? void 0 : msg.peerId) === null || _c === void 0 ? void 0 : _c.userId) {
            messageType = 'direct';
            entityId = msg.peerId.userId;
        }
        console.log(`Received a ${messageType} message`);
        if (!entityId) {
            console.log('This message is not from a chat, channel, or user');
            return;
        }
        // Get the entity name or ID
        let entityNameOrId = entityCache[entityId];
        if (!entityNameOrId) {
            try {
                const entity = await client.getEntity(entityId);
                if ('title' in entity) {
                    // Chats and channels
                    entityNameOrId = entity.title;
                }
                else if ('username' in entity) {
                    entityNameOrId = entity.username;
                }
                else if ('firstName' in entity) {
                    entityNameOrId = entity.firstName;
                }
                else {
                    entityNameOrId = entityId.toString();
                }
                entityCache[entityId] = entityNameOrId;
            }
            catch (error) {
                console.error('Error fetching entity:', error);
                entityNameOrId = entityId.toString();
            }
        }
        // Get the date in YYYY-MM-DD format
        const date = new Date().toISOString().split('T')[0];
        // Construct the filename
        const filename = `${entityNameOrId}-${date}.json`;
        // **Updated date handling**
        let dateString = '';
        if (msg.date) {
            if (msg.date instanceof Date) {
                dateString = msg.date.toISOString();
            }
            else if (typeof msg.date === 'number') {
                // Telegram might provide the date as a Unix timestamp in seconds
                dateString = new Date(msg.date * 1000).toISOString();
            }
            else if (typeof msg.date === 'bigint') {
                // If date is a BigInt, convert it to a number
                dateString = new Date(Number(msg.date) * 1000).toISOString();
            }
            else {
                console.warn('msg.date is of unexpected type:', typeof msg.date);
                dateString = new Date().toISOString(); // Fallback to current date
            }
        }
        else {
            console.warn('msg.date is undefined. Using current date as fallback.');
            dateString = new Date().toISOString(); // Fallback to current date
        }
        // Prepare the message data to log
        const messageData = {
            messageId: msg.id,
            date: dateString,
            text: msg.message,
            senderId: (_d = msg.senderId) === null || _d === void 0 ? void 0 : _d.value,
            senderUsername: (_e = msg.sender) === null || _e === void 0 ? void 0 : _e.username,
            senderFirstName: (_f = msg.sender) === null || _f === void 0 ? void 0 : _f.firstName,
            senderLastName: (_g = msg.sender) === null || _g === void 0 ? void 0 : _g.lastName,
        };
        // Add the message data to messagesMap
        if (!messagesMap[filename]) {
            messagesMap[filename] = [];
        }
        messagesMap[filename].push(messageData);
        let parsedCommand = msg.text ? parseCommand(msg.text) : null;
        console.log('Parsed command:', parsedCommand);
        let context = '';
        if (!parsedCommand && ((_h = msg.replyTo) === null || _h === void 0 ? void 0 : _h.replyToMsgId)) {
            const [repliedMessage] = await client.getMessages(entityId, {
                ids: [msg.replyTo.replyToMsgId],
                limit: 1,
            });
            if (((_j = repliedMessage.sender) === null || _j === void 0 ? void 0 : _j.username) === MY_USERNAME) {
                parsedCommand = parseCommand(repliedMessage.text || '');
                if (parsedCommand) {
                    console.log('This is a reply to your bot message!');
                    context = parsedCommand.content;
                    parsedCommand.content = msg.text || '';
                }
            }
        }
        if (parsedCommand) {
            try {
                console.log('Parsed command:', parsedCommand);
                console.log(parseCommand);
                const response = await sendPromptAndGetResponse(parsedCommand.command, parsedCommand.content, context = (parsedCommand.command === 'b)' ? candlecontext : ''));
                console.log('Automated reply:', response);
                await client.sendMessage(entityId, {
                    message: `${COMMANDS[parsedCommand.command].prefix} ${response}`,
                    replyTo: msg.id,
                });
                console.log('Automated reply sent successfully');
            }
            catch (error) {
                console.error('Error sending automated reply:', error);
            }
        }
    }
    // Function to check if a file exists
    async function fileExists(path) {
        try {
            await fs.access(path);
            return true;
        }
        catch (_a) {
            return false;
        }
    }
    // Function to save messages to files every 5 minutes
    setInterval(async () => {
        for (const filename in messagesMap) {
            const messages = messagesMap[filename];
            if (messages.length > 0) {
                try {
                    let allMessages = [];
                    if (await fileExists(filename)) {
                        // Read existing messages
                        const existingData = await fs.readFile(filename, 'utf8');
                        const existingMessages = JSON.parse(existingData);
                        // Append new messages
                        allMessages = existingMessages.concat(messages);
                    }
                    else {
                        allMessages = messages;
                    }
                    // Write messages to the file with a replacer for BigInt
                    await fs.writeFile(filename, JSON.stringify(allMessages, (key, value) => (typeof value === 'bigint' ? value.toString() : value), 2));
                    // Clear the messages array for this filename
                    messagesMap[filename] = [];
                }
                catch (error) {
                    console.error(`Error writing to file ${filename}:`, error);
                }
            }
        }
        console.log('Messages saved to files');
    }, 1 * 30 * 1000); // Every 5 minutes
    (async () => {
        console.log('Starting...');
        if (await login()) {
            console.log('You should now be connected.');
            console.log('Session string:', client.session.save());
            client.addEventHandler(handleNewMessage, new NewMessage({
                incoming: true,
                forwards: false,
            }));
            await new Promise(() => { });
        }
        else {
            console.log('Failed to log in. Exiting...');
        }
    })();
})();
