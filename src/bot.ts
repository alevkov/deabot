import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import * as dotenv from 'dotenv';
import input from 'input';
import axios from 'axios';
import { promises as fs } from 'fs';

dotenv.config();

const {
  TG_API_ID,
  TG_API_HASH,
  PHONE_NUMBER,
  SESSION_NAME,
  MY_USERNAME,
  LLM_CONTEXT_PATH,
  COMMAND_BASE_URL,
} = process.env;

if (!TG_API_ID || !TG_API_HASH || !PHONE_NUMBER || !MY_USERNAME || !LLM_CONTEXT_PATH || !COMMAND_BASE_URL) {
  console.error("Missing required environment variables. Please check your .env file.");
  process.exit(1);
}

const COMMANDS: { [key: string]: { prefix: string; endpoint: string; params: object } } = {
  q: {
    prefix: '!q',
    endpoint: `${COMMAND_BASE_URL}/q`,
    //params: '<EDIT>', // Replace with actual parameters
    params: {
      temperature: 0.3,
      tokens: 3000,
      model: 'openai-next',
      version: 'v2',
    }
  },
  b: {
    prefix: '!cb',
    endpoint: `${COMMAND_BASE_URL}/q`, // Assuming this is correct
    //params: '<EDIT>', // Replace with actual parameters
    params: {
      temperature: 0.92,
      tokens: 4000,
      format: "fun",
      model: "openai-next",
      version: "v2",
    }
  },
};

const stringSession = new StringSession(SESSION_NAME);

const client = new TelegramClient(
  stringSession,
  parseInt(TG_API_ID, 10),
  TG_API_HASH,
  { connectionRetries: 5 }
);

const messagesMap: { [filename: string]: any[] } = {};
const entityCache: { [id: number]: string } = {};

async function login(): Promise<boolean> {
  console.log('Starting login process...');

  for (let attempts = 1; attempts <= 3; attempts++) {
    try {
      console.log(`Attempt ${attempts} of 3`);
      await client.start({
        phoneNumber: () => PHONE_NUMBER,
        password: () => input.text('Please enter your 2FA password: '),
        phoneCode: () => input.text('Please enter the code you received: '),
        onError: (err) => console.error(err),
      });
      console.log('Login successful!');
      return true;
    } catch (error: any) {
      console.error(`Error during login: ${error.message}`);
      if (error.message.includes('PHONE_CODE_INVALID')) {
        console.log('Invalid phone code. Please try again.');
      } else if (error.message.includes('FLOOD_WAIT_')) {
        const waitTime = parseInt(error.message.split('_')[2]);
        console.log(`FloodWaitError: Need to wait ${waitTime} seconds before trying again.`);
        await new Promise((resolve) => setTimeout(resolve, waitTime * 1000));
      } else {
        throw error;
      }
    }
  }

  console.error('Max login attempts reached. Please try again later.');
  return false;
}

async function sendPromptAndGetResponse(
  command: string,
  question: string,
  context: string = ''
): Promise<string> {
  const { endpoint, params } = COMMANDS[command];
  try {
    const response = await axios.post(
      endpoint,
      { question, context, ...params },
      { headers: { 'Content-Type': 'application/json' } }
    );
    return response.data.assistant;
  } catch (error) {
    console.error(`Error sending prompt to ${endpoint}:`, error);
    return 'Sorry, I encountered an error while processing your request.';
  }
}

function parseCommand(text: string): { command: string; content: string } | null {
  for (const [key, value] of Object.entries(COMMANDS)) {
    if (text.startsWith(value.prefix)) {
      return { command: key, content: text.slice(value.prefix.length).trim() };
    }
  }
  return null;
}

async function handleNewMessage(event: NewMessage.Event) {
  const msg = event.message;
  let messageType = 'unknown';
  let entityId: number | undefined;
  console.log(msg.message)

  // Check for channel messages
  if (msg?.peerId?.channelId) {
    entityId = Number(msg.peerId.channelId.value);
    messageType = 'channel';
  }
  // Check for user messages (direct or group)
  else if (msg?.peerId?.userId) {
    entityId = Number(msg.peerId.userId.value); 
    if (msg.out) {
      messageType = 'outgoing';
    } else {
      messageType = 'direct'; 
    }
  }
  // Check for chat (group) messages
  else if (msg?.peerId?.chatId) {
    entityId = Number(msg.peerId.chatId.value);
    messageType = 'group';
  }

  console.log(`Received a ${messageType} message`);

  if (!entityId) {
    console.log('Unable to determine the entity ID for this message');
    return;
  }

  let entityNameOrId = entityCache[entityId];
  if (!entityNameOrId) {
    try {
      let entity;
      if (messageType === 'channel') {
        entity = await client.getEntity(entityId.toString());
      } else {
        entity = await client.getEntity(entityId);
      }

      if ('title' in entity) {
        entityNameOrId = entity.title;
      } else if ('username' in entity) {
        entityNameOrId = entity.username;
      } else if ('firstName' in entity) {
        entityNameOrId = entity.firstName;
      } else {
        entityNameOrId = entityId.toString();
      }
      entityCache[entityId] = entityNameOrId;

    } catch (error) {
      console.error('Error fetching entity:', error);

      try {
        // If fetching by ID fails, try fetching all dialogs to update the cache
        await client.getDialogs();

        // Now try fetching the entity again
        let entity;
        if (messageType === 'channel') {
          entity = await client.getEntity(entityId.toString());
        } else {
          entity = await client.getEntity(entityId);
        }

        if ('title' in entity) {
          entityNameOrId = entity.title;
        } else if ('username' in entity) {
          entityNameOrId = entity.username;
        } else if ('firstName' in entity) {
          entityNameOrId = entity.firstName;
        } else {
          entityNameOrId = entityId.toString();
        }
        entityCache[entityId] = entityNameOrId;

      } catch (error) {
        console.error('Error fetching entity after getDialogs:', error);
        entityNameOrId = entityId.toString();
        entityCache[entityId] = entityNameOrId;
      }
    }
  }

  console.log(`Entity name or ID: ${entityNameOrId}`);

  // Get the date in YYYY-MM-DD format
  const date = new Date().toISOString().split('T')[0];

  // Construct the filename
  const filename = `${entityNameOrId}-${date}.json`;

  // Updated date handling
  let dateString = '';
  if (msg.date) {
    if (msg.date instanceof Date) {
      dateString = msg.date.toISOString();
    } else if (typeof msg.date === 'number') {
      // Telegram might provide the date as a Unix timestamp in seconds
      dateString = new Date(msg.date * 1000).toISOString();
    } else if (typeof msg.date === 'bigint') {
      // If date is a BigInt, convert it to a number
      dateString = new Date(Number(msg.date) * 1000).toISOString();
    } else {
      console.warn('msg.date is of unexpected type:', typeof msg.date);
      dateString = new Date().toISOString(); // Fallback to current date
    }
  } else {
    console.warn('msg.date is undefined. Using current date as fallback.');
    dateString = new Date().toISOString(); // Fallback to current date
  }

  const messageData = {
    messageId: msg.id,
    date: dateString,
    text: msg.message,
    senderId: msg.senderId?.value,
    senderUsername: msg.sender?.username,
    senderFirstName: msg.sender?.firstName,
    senderLastName: msg.sender?.lastName,
  };

  messagesMap[filename] = messagesMap[filename] || [];
  messagesMap[filename].push(messageData);

  let parsedCommand = msg.text ? parseCommand(msg.text) : null;

  if (!parsedCommand && msg.replyTo?.replyToMsgId) {
    try { 
      const [repliedMessage] = await client.getMessages(entityId, { 
        ids: [msg.replyTo.replyToMsgId],
        limit: 1,
      });
      if (repliedMessage.sender?.username === MY_USERNAME) {
        parsedCommand = parseCommand(repliedMessage.text || '');
        if (parsedCommand) {
          parsedCommand.content = msg.text || '';
        }
      }
    } catch (error) {
      console.error('Error fetching replied message:', error);
      // Handle the error, e.g., by sending a message to the user or logging the error
    }
  }

  if (parsedCommand) {
    try {
      const llmcontext = await fs.readFile(LLM_CONTEXT_PATH as string, 'utf8'); // Read context here
      const response = await sendPromptAndGetResponse(
        parsedCommand.command,
        parsedCommand.content,
        llmcontext // Pass the context to the function
      );
      console.log('Automated reply:', response);
      await client.sendMessage(entityId, { 
        message: `${COMMANDS[parsedCommand.command].prefix} ${response}`,
        replyTo: msg.id,
      });
      console.log('Automated reply sent successfully');
    } catch (error) {
      console.error('Error sending automated reply:', error);
    }
  }
}

async function saveMessagesToFile() {
  for (const filename in messagesMap) {
    const messages = messagesMap[filename];
    if (messages.length > 0) {
      try {
        const existingData = await fs.readFile(`./logs/${filename}`, 'utf8').catch(() => '[]');
        const allMessages = JSON.parse(existingData).concat(messages);
        await fs.writeFile(
          `./logs/${filename}`,
          JSON.stringify(allMessages, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value, 2)
        );
        messagesMap[filename] = [];
      } catch (error) {
        console.error(`Error writing to file ${filename}:`, error);
      }
    }
  }
  console.log('Messages saved to files');
}

setInterval(saveMessagesToFile, 5 * 60 * 1000); // Every 5 minutes


(async () => {
  console.log('Starting...');
  if (await login()) {
    console.log('You should now be connected.');
    console.log('Session string:', client.session.save());

    client.addEventHandler(
      handleNewMessage,
      new NewMessage({ incoming: true, forwards: false })
    );

    await new Promise(() => { }); // Keep the process alive
  } else {
    console.log('Failed to log in. Exiting...');
  }
})();