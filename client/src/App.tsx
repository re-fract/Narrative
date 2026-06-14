import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import HomePage from './pages/HomePage'
import FollowingPage from './pages/FollowingPage'
import ArticleViewPage from './pages/ArticleViewPage'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/following" element={<FollowingPage />} />
          <Route path="/article/:id" element={<ArticleViewPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
