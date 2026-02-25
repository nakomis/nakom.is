import { useState } from 'react';
import SocialLinks from './components/SocialLinks'
import ChatWidget from './components/ChatWidget'
import ConnectorLines from './components/ConnectorLines'
import Footer from './components/Footer'

function App() {
  const [activeTools, setActiveTools] = useState<Set<string>>(new Set());

  return (
    <div className="app-layout">
      <h1>Martin Harris</h1>
      <SocialLinks />
      <ChatWidget activeTools={activeTools} onActiveToolsChange={setActiveTools} />
      <ConnectorLines activeTools={activeTools} />
      <Footer />
    </div>
  )
}

export default App
