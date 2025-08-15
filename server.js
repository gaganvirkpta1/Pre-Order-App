import express from 'express';
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Preorder app running'));
app.listen(PORT, () => console.log(`Running on ${PORT}`));
