const express = require('express');
const cors = require('cors');
const { Client } = require('@notionhq/client');

const app = express();
app.use(express.json());
app.use(cors());

const notion = new Client({ auth: process.env.NOTION_API_KEY });

let currentTask = null;
let taskStartTime = null;
let verificationToken = null;

// Receive webhook from Notion
app.post('/webhook', async (req, res) => {
  try {
    const event = req.body;

    // Notion sends a verification request on webhook setup
    if (event.type === 'ping') {
      verificationToken = req.body.verification_token;
      console.log('Received verification token:', verificationToken);
      return res.status(200).json({ verification_token: verificationToken });
    }

    // Handle page updates
    if (event.type === 'page_updated' && event.object.type === 'page') {
      const pageId = event.object.id;

      // Fetch the page to get current-task field
      const page = await notion.pages.retrieve({ page_id: pageId });

      // Check if this page has current-task set to true
      const currentTaskField = page.properties['current-task'];
      const isCurrentTask = currentTaskField?.checkbox || false;

      if (isCurrentTask && currentTask !== pageId) {
        // New task started - save old task's time if there was one
        if (currentTask && taskStartTime) {
          await saveTaskTime(currentTask, taskStartTime);
        }

        // Update current task
        currentTask = pageId;
        taskStartTime = Date.now();
      } else if (!isCurrentTask && currentTask === pageId) {
        // Current task was unchecked
        if (taskStartTime) {
          await saveTaskTime(currentTask, taskStartTime);
        }
        currentTask = null;
        taskStartTime = null;
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get verification token
app.get('/verification-token', (req, res) => {
  if (verificationToken) {
    res.json({ verification_token: verificationToken });
  } else {
    res.json({ verification_token: null, message: 'No token received yet' });
  }
});

// Get current task info
app.get('/current-task', async (req, res) => {
  try {
    if (!currentTask) {
      return res.json({ task: null, elapsedMs: 0 });
    }

    const page = await notion.pages.retrieve({ page_id: currentTask });
    const titleField = page.properties.title || page.properties.Name;
    const taskName = titleField?.title?.[0]?.plain_text || 'Untitled';

    const elapsedMs = taskStartTime ? Date.now() - taskStartTime : 0;

    res.json({
      task: {
        id: currentTask,
        name: taskName,
      },
      elapsedMs,
    });
  } catch (error) {
    console.error('Error fetching task:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper: save time spent to Notion
async function saveTaskTime(pageId, startTime) {
  try {
    const elapsedMs = Date.now() - startTime;
    const elapsedMinutes = Math.floor(elapsedMs / 60000);

    // Get current time spent value
    const page = await notion.pages.retrieve({ page_id: pageId });
    const currentTimeSpent = page.properties['Time Spent']?.number || 0;

    // Update with cumulative time
    await notion.pages.update({
      page_id: pageId,
      properties: {
        'Time Spent': {
          number: currentTimeSpent + elapsedMinutes,
        },
      },
    });
  } catch (error) {
    console.error('Error saving task time:', error);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
