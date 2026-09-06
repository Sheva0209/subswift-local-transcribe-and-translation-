const fs = require('fs');
const OpenAI = require('openai');
require('dotenv').config({ path: 'd:/AUTO TRANSLATION AND SUBTITLE/clip-studio/.env' });

async function test() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const srtContent = fs.readFileSync('d:/AUTO TRANSLATION AND SUBTITLE/clip-studio/storage/transcripts/5bfbb611-a536-4d82-a583-55c805d36158.srt', 'utf-8');
  const blocks = srtContent.trim().split(/\n\n+/);
  const CHUNK_SIZE = 80;
  const chunks = [];
  for (let i = 0; i < blocks.length; i += CHUNK_SIZE) {
    chunks.push(blocks.slice(i, i + CHUNK_SIZE).join('\n\n'));
  }
  
  const chunk3 = chunks[2]; // chunk 3 (index 2)
  console.log("Chunk 3 length:", chunk3.length);

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Translate to English. Keep exact SRT format.' },
        { role: 'user', content: chunk3 }
      ],
      temperature: 0.3,
      max_tokens: 4000,
    });
    console.log("Finish reason:", completion.choices[0].finish_reason);
    console.log("Content:", completion.choices[0].message.content.slice(0, 200) + '...');
  } catch (err) {
    console.error("Error:", err.message);
  }
}

test();
