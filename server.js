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
    console.log('Received request:', JSON.stringify(event, null, 2));

    // Notion sends a verification request on webhook setup
    if (event.type === 'ping') {
      verificationToken = event.verification_token;
      console.log('Stored verification token:', verificationToken);
      return res.status(200).json({ verification_token: verificationToken });
    }

    // Handle page property updates
    if (event.type === 'page.properties_updated') {
      const pageId = event.entity.id;
      
      try {
        // Fetch the page to get current-task field
        const page = await notion.pages.retrieve({ page_id: pageId });
        console.log('Page properties:', Object.keys(page.properties));
        const currentTaskField = page.properties['current-task'];
        console.log('current-task field:', JSON.stringify(currentTaskField));
        const isCurrentTask = currentTaskField?.checkbox || false;
        console.log('Is current task:', isCurrentTask);

        if (isCurrentTask && currentTask !== pageId) {
          // New task started - save old task's time if there was one
          if (currentTask && taskStartTime) {
            await saveTaskTime(currentTask, taskStartTime);
          }

          // Update current task
          currentTask = pageId;
          taskStartTime = Date.now();
          console.log('Current task set to:', pageId);
        } else if (!isCurrentTask && currentTask === pageId) {
          // Current task was unchecked
          if (taskStartTime) {
            await saveTaskTime(currentTask, taskStartTime);
          }
          currentTask = null;
          taskStartTime = null;
          console.log('Current task cleared');
        }
      } catch (err) {
        console.error('Error processing page update:', err);
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
    const titleField = page.properties['Action Item'];
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

// Finish current task (check Done, uncheck current-task)
app.post('/finish-task', async (req, res) => {
  try {
    if (!currentTask) {
      return res.status(400).json({ error: 'No current task' });
    }

    // Check Done checkbox and uncheck current-task
    await notion.pages.update({
      page_id: currentTask,
      properties: {
        'Done': { checkbox: true },
        'current-task': { checkbox: false },
      },
    });

    // Save time before clearing
    if (taskStartTime) {
      await saveTaskTime(currentTask, taskStartTime);
    }

    // Clear current task
    currentTask = null;
    taskStartTime = null;

    res.json({ ok: true });
  } catch (err) {
    console.error('Error finishing task:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get next task in queue
app.post('/get-next-task', async (req, res) => {
  try {
    if (!currentTask) {
      return res.json({ nextTask: null });
    }

    const { databaseId } = req.body;
    const currentPage = await notion.pages.retrieve({ page_id: currentTask });
    const currentDay = currentPage.properties['Day']?.date?.start;

    if (!currentDay || !databaseId) {
      return res.json({ nextTask: null });
    }

    // Query for next task
    const results = await notion.databases.query({
      database_id: databaseId,
      filter: {
        and: [
          {
            property: 'Day',
            date: {
              equals: currentDay,
            },
          },
          {
            property: 'Done',
            checkbox: {
              equals: false,
            },
          },
          {
            property: 'current-task',
            checkbox: {
              equals: false,
            },
          },
        ],
      },
      sorts: [
        {
          property: 'Container',
          direction: 'ascending',
        },
        {
          property: 'Action Item',
          direction: 'ascending',
        },
      ],
    });

    if (results.results.length === 0) {
      return res.json({ nextTask: null });
    }

    const nextPage = results.results[0];
    const nextTaskName = nextPage.properties['Action Item']?.title?.[0]?.plain_text || 'Untitled';

    res.json({
      nextTask: {
        id: nextPage.id,
        name: nextTaskName,
      },
    });
  } catch (err) {
    console.error('Error getting next task:', err);
    res.status(500).json({ error: err.message });
  }
});

// Set next task (uncheck current, check next's current-task)
app.post('/set-next-task', async (req, res) => {
  try {
    const { nextTaskId } = req.body;

    if (!nextTaskId) {
      return res.status(400).json({ error: 'No nextTaskId provided' });
    }

    // Uncheck current task
    if (currentTask) {
      await notion.pages.update({
        page_id: currentTask,
        properties: {
          'current-task': { checkbox: false },
        },
      });
    }

    // Check next task
    await notion.pages.update({
      page_id: nextTaskId,
      properties: {
        'current-task': { checkbox: true },
      },
    });

    // Update current task
    currentTask = nextTaskId;
    taskStartTime = Date.now();

    res.json({ ok: true });
  } catch (err) {
    console.error('Error setting next task:', err);
    res.status(500).json({ error: err.message });
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
