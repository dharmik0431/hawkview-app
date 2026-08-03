'use client'

import React, { createContext, useContext, useState, useEffect } from 'react'

interface SidebarContextType {
  isCollapsed: boolean
  toggleCollapsed: () => void
  setIsCollapsed: (collapsed: boolean) => void
  mounted: boolean
}

const SidebarContext = createContext<SidebarContextType>({
  isCollapsed: false,
  toggleCollapsed: () => {},
  setIsCollapsed: () => {},
  mounted: false,
})

export const LOCAL_STORAGE_KEY = 'hawkview-sidebar-collapsed'

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [isCollapsed, setIsCollapsedState] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY)
      if (saved !== null) {
        setIsCollapsedState(saved === 'true')
      }
    } catch {
      // localStorage unavailable
    }
  }, [])

  const setIsCollapsed = (collapsed: boolean) => {
    setIsCollapsedState(collapsed)
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, String(collapsed))
    } catch {
      // localStorage unavailable
    }
  }

  const toggleCollapsed = () => {
    setIsCollapsed(!isCollapsed)
  }

  return (
    <SidebarContext.Provider
      value={{
        isCollapsed,
        toggleCollapsed,
        setIsCollapsed,
        mounted,
      }}
    >
      {children}
    </SidebarContext.Provider>
  )
}

export function useSidebar() {
  return useContext(SidebarContext)
}
