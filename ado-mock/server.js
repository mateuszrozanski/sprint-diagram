const express = require('express');
const cors    = require('cors');
const app     = express();
app.use(cors());
app.use(express.json());

// ── Mock data ─────────────────────────────────────────────────────────────────
// Odzwierciedla format ADO REST API:
//   GET /{org}/{project}/_apis/wit/wiql  → lista ID
//   GET /{org}/{project}/_apis/wit/workitems?ids=...&$expand=relations → szczegóły

const WORK_ITEMS = [
  // ── PBI-101: User Authentication ──────────────────────────────────────────
  {
    id: 101,
    fields: {
      'System.WorkItemType':           'User Story',
      'System.Title':                  'User Authentication',
      'System.AssignedTo':             { displayName: 'Alice K.' },
      'Microsoft.VSTS.Common.Priority': 1,
      'System.Tags':                   '',
    },
    relations: [
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'workitems/1011' },
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'workitems/1012' },
      { rel: 'System.LinkTypes.Dependency-Forward', url: 'workitems/102' }, // predecessor of 102
    ],
  },
  // subtaski PBI-101
  {
    id: 1011,
    fields: {
      'System.WorkItemType':                        'Task',
      'System.Title':                               'Auth – Backend',
      'System.AssignedTo':                          { displayName: 'Alice K.' },
      'System.Tags':                                'backend',
      'Microsoft.VSTS.Scheduling.RemainingWork':    12, // 2 dni
      'System.AreaPath':                            '',
    },
  },
  {
    id: 1012,
    fields: {
      'System.WorkItemType':                        'Task',
      'System.Title':                               'Auth – Frontend',
      'System.AssignedTo':                          { displayName: 'Bob M.' },
      'System.Tags':                                'frontend',
      'Microsoft.VSTS.Scheduling.RemainingWork':    12, // 2 dni
      'System.AreaPath':                            '',
    },
  },

  // ── PBI-102: Payment Integration (depends on 101) ─────────────────────────
  {
    id: 102,
    fields: {
      'System.WorkItemType':           'User Story',
      'System.Title':                  'Payment Integration',
      'System.AssignedTo':             { displayName: 'David W.' },
      'Microsoft.VSTS.Common.Priority': 2,
      'System.Tags':                   '',
    },
    relations: [
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'workitems/1021' },
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'workitems/1022' },
      { rel: 'System.LinkTypes.Dependency-Reverse', url: 'workitems/101' }, // depends on 101
    ],
  },
  {
    id: 1021,
    fields: {
      'System.WorkItemType':                        'Task',
      'System.Title':                               'Payments – Backend',
      'System.AssignedTo':                          { displayName: 'David W.' },
      'System.Tags':                                'backend',
      'Microsoft.VSTS.Scheduling.RemainingWork':    12,
    },
  },
  {
    id: 1022,
    fields: {
      'System.WorkItemType':                        'Task',
      'System.Title':                               'Payments – Frontend',
      'System.AssignedTo':                          { displayName: 'Bob M.' },
      'System.Tags':                                'frontend',
      'Microsoft.VSTS.Scheduling.RemainingWork':    12,
    },
  },

  // ── PBI-103: Product Catalog ──────────────────────────────────────────────
  {
    id: 103,
    fields: {
      'System.WorkItemType':           'User Story',
      'System.Title':                  'Product Catalog',
      'System.AssignedTo':             { displayName: 'Carol P.' },
      'Microsoft.VSTS.Common.Priority': 2,
      'System.Tags':                   '',
    },
    relations: [
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'workitems/1031' },
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'workitems/1032' },
    ],
  },
  {
    id: 1031,
    fields: {
      'System.WorkItemType':                        'Task',
      'System.Title':                               'Catalog – Frontend',
      'System.AssignedTo':                          { displayName: 'Carol P.' },
      'System.Tags':                                'frontend',
      'Microsoft.VSTS.Scheduling.RemainingWork':    18, // 3 dni
    },
  },
  {
    id: 1032,
    fields: {
      'System.WorkItemType':                        'Task',
      'System.Title':                               'Catalog – Backend',
      'System.AssignedTo':                          { displayName: 'David W.' },
      'System.Tags':                                'backend',
      'Microsoft.VSTS.Scheduling.RemainingWork':    12,
    },
  },

  // ── BUG-201 ───────────────────────────────────────────────────────────────
  {
    id: 201,
    fields: {
      'System.WorkItemType':           'Bug',
      'System.Title':                  'Login crash on iOS 17',
      'System.AssignedTo':             { displayName: 'Bob M.' },
      'Microsoft.VSTS.Common.Priority': 1,
      'System.Tags':                   '',
    },
    relations: [
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'workitems/2011' },
    ],
  },
  {
    id: 2011,
    fields: {
      'System.WorkItemType':                        'Task',
      'System.Title':                               'Fix iOS crash',
      'System.AssignedTo':                          { displayName: 'Bob M.' },
      'System.Tags':                                'backend',
      'Microsoft.VSTS.Scheduling.RemainingWork':    3, // 0.5 dnia
    },
  },

  // ── PBI-104: User Profile (depends on 101) ────────────────────────────────
  {
    id: 104,
    fields: {
      'System.WorkItemType':           'User Story',
      'System.Title':                  'User Profile & Settings',
      'System.AssignedTo':             { displayName: 'Alice K.' },
      'Microsoft.VSTS.Common.Priority': 3,
      'System.Tags':                   '',
    },
    relations: [
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'workitems/1041' },
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'workitems/1042' },
      { rel: 'System.LinkTypes.Dependency-Reverse', url: 'workitems/101' },
    ],
  },
  {
    id: 1041,
    fields: {
      'System.WorkItemType':                        'Task',
      'System.Title':                               'Profile – Backend',
      'System.AssignedTo':                          { displayName: 'Alice K.' },
      'System.Tags':                                'backend',
      'Microsoft.VSTS.Scheduling.RemainingWork':    6, // 1 dzień
    },
  },
  {
    id: 1042,
    fields: {
      'System.WorkItemType':                        'Task',
      'System.Title':                               'Profile – Frontend',
      'System.AssignedTo':                          { displayName: 'Carol P.' },
      'System.Tags':                                'frontend',
      'Microsoft.VSTS.Scheduling.RemainingWork':    12,
    },
  },
];

const itemMap = new Map(WORK_ITEMS.map(i => [i.id, i]));

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractId(url) {
  return parseInt(url.split('/').pop(), 10);
}

function itemResponse(item) {
  return {
    id:        item.id,
    fields:    item.fields,
    relations: item.relations ?? [],
    _links:    { self: { href: `http://localhost:3333/workitems/${item.id}` } },
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// WIQL — zwraca ID PBI (User Story + Bug) dla bieżącego sprintu
app.post('/:org/:project/_apis/wit/wiql', (req, res) => {
  const pbis = WORK_ITEMS.filter(i => {
    const type = i.fields['System.WorkItemType'];
    return type === 'User Story' || type === 'Bug';
  });
  res.json({
    workItems: pbis.map(i => ({ id: i.id, url: `http://localhost:3333/workitems/${i.id}` })),
  });
});

// Batch — pobierz wiele itemów po ID (z rozwinięciem relacji)
app.get('/:org/:project/_apis/wit/workitems', (req, res) => {
  const ids = String(req.query.ids ?? '').split(',').map(Number).filter(Boolean);
  const items = ids.map(id => itemMap.get(id)).filter(Boolean);
  res.json({ count: items.length, value: items.map(itemResponse) });
});

// Pojedynczy item
app.get('/:org/:project/_apis/wit/workitems/:id', (req, res) => {
  const item = itemMap.get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'not found' });
  res.json(itemResponse(item));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = 3333;
app.listen(PORT, () => console.log(`ADO mock server running on http://localhost:${PORT}`));
